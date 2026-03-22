<?php

/**
 * FhirSlotService generates FHIR R4 Slot resources from OpenEMR provider availability data.
 *
 * Each FHIR Slot represents one bookable time window.  Slots are computed on-the-fly from
 * two data sources:
 *
 *   1. Availability blocks — `openemr_postcalendar_events` rows where `pc_pid = 0`.
 *      Each block defines a contiguous time window the provider is available (e.g. 08:00–16:00).
 *      The slot step size is derived from the block's appointment category duration, falling back
 *      to 30 minutes.
 *
 *   2. Existing appointments — rows where `pc_pid > 0` for the same provider and date range.
 *      Any computed slot whose start time coincides with an existing appointment is returned with
 *      `status = busy`; otherwise `status = free`.
 *
 * Slot UUID: deterministic MD5-based UUID derived from (provider_id, date, HH:MM).
 * This is stable across requests for the same logical slot.
 *
 * Supported search parameters:
 *   _id       — Deterministic slot UUID
 *   schedule  — Reference to the owning Schedule (= provider UUID), e.g. Schedule/{uuid}
 *   start     — Date range for slot start times (ge/le/eq modifiers supported)
 *   status    — Filter by status: free | busy | busy-unavailable | busy-tentative
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    PolarisAiAgent
 * @copyright Copyright (c) 2025 PolarisAiAgent
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

namespace OpenEMR\Services\FHIR;

use OpenEMR\Common\Database\QueryUtils;
use OpenEMR\Common\Uuid\UuidRegistry;
use OpenEMR\FHIR\R4\FHIRDomainResource\FHIRSlot;
use OpenEMR\FHIR\R4\FHIRElement\FHIRCode;
use OpenEMR\FHIR\R4\FHIRElement\FHIRId;
use OpenEMR\FHIR\R4\FHIRElement\FHIRInstant;
use OpenEMR\FHIR\R4\FHIRElement\FHIRMeta;
use OpenEMR\FHIR\R4\FHIRElement\FHIRReference;
use OpenEMR\FHIR\R4\FHIRElement\FHIRSlotStatus;
use OpenEMR\Services\FHIR\Traits\FhirServiceBaseEmptyTrait;
use OpenEMR\Services\Search\FhirSearchParameterDefinition;
use OpenEMR\Services\Search\SearchFieldType;
use OpenEMR\Services\Search\ServiceField;
use OpenEMR\Validators\ProcessingResult;

class FhirSlotService extends FhirServiceBase
{
    use FhirServiceBaseEmptyTrait;

    /** Default slot duration when category duration cannot be determined (30 minutes) */
    private const DEFAULT_SLOT_DURATION_SECS = 1800;

    /**
     * @inheritDoc
     */
    protected function loadSearchParameters()
    {
        return [
            '_id' => new FhirSearchParameterDefinition(
                '_id',
                SearchFieldType::TOKEN,
                [new ServiceField('slot_uuid', ServiceField::TYPE_STRING)]
            ),
            'schedule' => new FhirSearchParameterDefinition(
                'schedule',
                SearchFieldType::REFERENCE,
                [new ServiceField('provider_uuid', ServiceField::TYPE_UUID)]
            ),
            'start' => new FhirSearchParameterDefinition(
                'start',
                SearchFieldType::DATE,
                ['block_date']
            ),
            'status' => new FhirSearchParameterDefinition(
                'status',
                SearchFieldType::TOKEN,
                [new ServiceField('slot_status', ServiceField::TYPE_STRING)]
            ),
        ];
    }

    /**
     * @inheritDoc
     */
    public function parseOpenEMRRecord($dataRecord = [], $encode = false)
    {
        $slot = new FHIRSlot();

        $meta = new FHIRMeta();
        $meta->setVersionId("1");
        $slot->setMeta($meta);

        $id = new FHIRId();
        $id->setValue($dataRecord['slot_uuid']);
        $slot->setId($id);

        // Reference back to the owning Schedule (= provider UUID)
        $scheduleRef = new FHIRReference();
        $scheduleRef->setReference("Schedule/{$dataRecord['provider_uuid']}");
        $slot->setSchedule($scheduleRef);

        // Status: free | busy
        $status = new FHIRSlotStatus();
        $status->setValue($dataRecord['slot_status'] ?? 'free');
        $slot->setStatus($status);

        // Start / end instants
        $startDateTime = $dataRecord['block_date'] . ' ' . $dataRecord['slot_start'];
        $endDateTime   = $dataRecord['block_date'] . ' ' . $dataRecord['slot_end'];
        $slot->setStart(new FHIRInstant(UtilsService::getLocalDateAsUTC($startDateTime)));
        $slot->setEnd(new FHIRInstant(UtilsService::getLocalDateAsUTC($endDateTime)));

        if ($encode) {
            return json_encode($slot);
        }
        return $slot;
    }

    /**
     * @inheritDoc
     */
    protected function searchForOpenEMRRecords($openEMRSearchParameters): ProcessingResult
    {
        $processingResult = new ProcessingResult();

        $providerUuid  = $this->extractScheduleProviderUuid($openEMRSearchParameters);
        $dateConstraints = $this->extractDateConstraints($openEMRSearchParameters);
        $statusFilter  = $this->extractStatusFilter($openEMRSearchParameters);

        if ($providerUuid === null && empty($dateConstraints)) {
            // Require at least a schedule or date filter to prevent full-table scans
            $processingResult->setValidationMessages([
                'schedule' => 'At least one of schedule or start is required',
            ]);
            return $processingResult;
        }

        // ── Step 1: Resolve provider numeric ID from UUID ────────────────────
        $providerId = null;
        if ($providerUuid !== null) {
            $providerId = QueryUtils::fetchSingleValue(
                "SELECT id FROM users WHERE uuid = ? AND active = 1",
                'id',
                [UuidRegistry::uuidToBytes($providerUuid)]
            );
            if ($providerId === null) {
                // Provider not found — return empty result set
                return $processingResult;
            }
        }

        // ── Step 2: Fetch availability blocks ─────────────────────────────────
        $blockSql = "SELECT
                         pce.pc_eid,
                         pce.pc_aid,
                         pce.pc_eventDate   AS block_date,
                         pce.pc_startTime   AS block_start,
                         pce.pc_endTime     AS block_end,
                         pce.pc_catid,
                         cat.pc_duration    AS cat_duration,
                         LOWER(CONCAT(
                             SUBSTR(HEX(u.uuid), 1,  8), '-',
                             SUBSTR(HEX(u.uuid), 9,  4), '-',
                             SUBSTR(HEX(u.uuid), 13, 4), '-',
                             SUBSTR(HEX(u.uuid), 17, 4), '-',
                             SUBSTR(HEX(u.uuid), 21, 12)
                         ))                 AS provider_uuid,
                         u.id               AS provider_id
                     FROM openemr_postcalendar_events pce
                     INNER JOIN users u ON u.id = pce.pc_aid
                     LEFT JOIN openemr_postcalendar_categories cat ON cat.pc_catid = pce.pc_catid
                     WHERE pce.pc_pid = 0
                       AND u.active = 1";

        $blockBind = [];
        if ($providerId !== null) {
            $blockSql .= " AND pce.pc_aid = ?";
            $blockBind[] = $providerId;
        }

        // Determine date bounds from constraints for the block query
        $dateStart = null;
        $dateEnd   = null;
        foreach ($dateConstraints as [$comp, $date]) {
            if (in_array($comp, ['ge', 'gt', 'eq'])) {
                $dateStart = $dateStart === null ? $date : min($dateStart, $date);
            }
            if (in_array($comp, ['le', 'lt', 'eq'])) {
                $dateEnd = $dateEnd === null ? $date : max($dateEnd, $date);
            }
        }
        if ($dateStart !== null) {
            $blockSql .= " AND pce.pc_eventDate >= ?";
            $blockBind[] = $dateStart;
        }
        if ($dateEnd !== null) {
            $blockSql .= " AND pce.pc_eventDate <= ?";
            $blockBind[] = $dateEnd;
        }

        $blockSql .= " ORDER BY pce.pc_eventDate, pce.pc_startTime";
        $blocks = QueryUtils::fetchRecords($blockSql, $blockBind);

        if (empty($blocks)) {
            return $processingResult;
        }

        // ── Step 3: Fetch existing appointments for busy detection ────────────
        // Collect all (provider_id, date) pairs from the blocks
        $busySet = $this->loadBusyTimes($blocks);

        // ── Step 4: Expand blocks into individual slots ───────────────────────
        foreach ($blocks as $block) {
            $durSecs  = !empty($block['cat_duration']) ? (int) $block['cat_duration'] : self::DEFAULT_SLOT_DURATION_SECS;
            $durMins  = max(1, (int) floor($durSecs / 60));
            $blockDate = $block['block_date'];

            // Parse block start/end as minutes-from-midnight
            [$openH, $openM]  = array_map('intval', explode(':', substr($block['block_start'], 0, 5)));
            [$closeH, $closeM] = array_map('intval', explode(':', substr($block['block_end'],   0, 5)));
            $openMin  = $openH  * 60 + $openM;
            $closeMin = $closeH * 60 + $closeM;

            for ($startMin = $openMin; $startMin + $durMins <= $closeMin; $startMin += $durMins) {
                $endMin = $startMin + $durMins;

                $hh    = str_pad((string) intdiv($startMin, 60), 2, '0', STR_PAD_LEFT);
                $mm    = str_pad((string) ($startMin % 60),      2, '0', STR_PAD_LEFT);
                $ehh   = str_pad((string) intdiv($endMin, 60),   2, '0', STR_PAD_LEFT);
                $emm   = str_pad((string) ($endMin % 60),        2, '0', STR_PAD_LEFT);
                $startTime = "{$hh}:{$mm}";
                $endTime   = "{$ehh}:{$emm}";

                $isBusy = isset($busySet[(int) $block['provider_id']][$blockDate][$startTime]);
                $status = $isBusy ? 'busy' : 'free';

                if ($statusFilter !== null && $status !== $statusFilter) {
                    continue;
                }

                // Apply date constraints to individual slot start times
                if (!$this->slotMatchesDateConstraints($blockDate, $dateConstraints)) {
                    continue;
                }

                $slotRecord = [
                    'slot_uuid'    => $this->computeSlotUuid((int) $block['provider_id'], $blockDate, $startTime),
                    'provider_uuid' => $block['provider_uuid'],
                    'provider_id'  => $block['provider_id'],
                    'block_date'   => $blockDate,
                    'slot_start'   => $startTime . ':00',
                    'slot_end'     => $endTime   . ':00',
                    'slot_status'  => $status,
                ];
                $processingResult->addData($slotRecord);
            }
        }

        return $processingResult;
    }

    /**
     * @inheritDoc
     */
    public function createProvenanceResource($dataRecord, $encode = false)
    {
        return null;
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    /**
     * Load existing appointment start times for the providers/dates in the given blocks.
     * Returns a nested array: [provider_id][date][HH:MM] = true
     *
     * @param array[] $blocks
     * @return array<int, array<string, array<string, bool>>>
     */
    private function loadBusyTimes(array $blocks): array
    {
        if (empty($blocks)) {
            return [];
        }

        // Build unique (provider_id, date) pairs
        $pairs = [];
        foreach ($blocks as $b) {
            $pairs[(int) $b['provider_id']][$b['block_date']] = true;
        }

        $busy = [];
        foreach ($pairs as $pid => $dates) {
            $placeholders = implode(',', array_fill(0, count($dates), '?'));
            $apptSql = "SELECT pc_aid, pc_eventDate, SUBSTR(pc_startTime, 1, 5) AS start_hhmm
                        FROM openemr_postcalendar_events
                        WHERE pc_pid > 0
                          AND pc_aid = ?
                          AND pc_eventDate IN ({$placeholders})";
            $apptBind = array_merge([$pid], array_keys($dates));
            $appts = QueryUtils::fetchRecords($apptSql, $apptBind);
            foreach ($appts as $a) {
                $busy[$pid][$a['pc_eventDate']][$a['start_hhmm']] = true;
            }
        }
        return $busy;
    }

    /**
     * Generate a deterministic UUID v3-style from (provider_id, date, HH:MM).
     * The UUID is stable across requests for the same logical slot.
     */
    private function computeSlotUuid(int $providerId, string $date, string $startHHmm): string
    {
        $hash = md5("openemr-slot-{$providerId}-{$date}-{$startHHmm}");
        return sprintf(
            '%s-%s-3%s-%s-%s',
            substr($hash, 0, 8),
            substr($hash, 8, 4),
            substr($hash, 13, 3),
            dechex((int) (hexdec(substr($hash, 16, 2)) & 0x3f) | 0x80) . substr($hash, 18, 2),
            substr($hash, 20, 12)
        );
    }

    /**
     * Extract provider UUID from the `schedule` or `_id` search parameter.
     * Handles "Schedule/{uuid}" reference format as well as a plain UUID.
     */
    private function extractScheduleProviderUuid(array $searchParameters): ?string
    {
        foreach (['schedule', '_id'] as $key) {
            if (empty($searchParameters[$key])) {
                continue;
            }
            $field  = $searchParameters[$key];
            $values = method_exists($field, 'getValues') ? $field->getValues() : [];
            if (empty($values)) {
                continue;
            }
            $raw = method_exists($values[0], 'getValue') ? (string) $values[0]->getValue() : (string) $values[0];
            if ($raw === '') {
                continue;
            }
            if (strpos($raw, '/') !== false) {
                $raw = substr($raw, strrpos($raw, '/') + 1);
            }
            return $raw;
        }
        return null;
    }

    /**
     * Extract date comparator/value pairs from the `start` search parameter.
     * @return array<int, array{0: string, 1: string}>
     */
    private function extractDateConstraints(array $searchParameters): array
    {
        $constraints = [];
        if (empty($searchParameters['start'])) {
            return $constraints;
        }
        $field  = $searchParameters['start'];
        $values = method_exists($field, 'getValues') ? $field->getValues() : [];
        foreach ($values as $v) {
            $comparator = method_exists($v, 'getComparator') ? $v->getComparator() : 'eq';
            $value      = method_exists($v, 'getValue') ? (string) $v->getValue() : (string) $v;
            if (strlen($value) > 10) {
                $value = substr($value, 0, 10);
            }
            if ($value !== '') {
                $constraints[] = [$comparator, $value];
            }
        }
        return $constraints;
    }

    /**
     * Check whether a slot date satisfies all date constraints.
     * @param array<int, array{0: string, 1: string}> $constraints
     */
    private function slotMatchesDateConstraints(string $slotDate, array $constraints): bool
    {
        foreach ($constraints as [$comp, $date]) {
            switch ($comp) {
                case 'eq':
                    if ($slotDate !== $date) return false;
                    break;
                case 'ge':
                    if ($slotDate < $date) return false;
                    break;
                case 'gt':
                    if ($slotDate <= $date) return false;
                    break;
                case 'le':
                    if ($slotDate > $date) return false;
                    break;
                case 'lt':
                    if ($slotDate >= $date) return false;
                    break;
            }
        }
        return true;
    }

    /**
     * Extract the desired slot status string from the `status` search parameter.
     */
    private function extractStatusFilter(array $searchParameters): ?string
    {
        if (empty($searchParameters['status'])) {
            return null;
        }
        $field  = $searchParameters['status'];
        $values = method_exists($field, 'getValues') ? $field->getValues() : [];
        if (empty($values)) {
            return null;
        }
        $raw = method_exists($values[0], 'getValue') ? (string) $values[0]->getValue() : (string) $values[0];
        return $raw !== '' ? strtolower($raw) : null;
    }
}
