<?php

/**
 * FhirScheduleService maps OpenEMR provider availability blocks to FHIR R4 Schedule resources.
 *
 * A FHIR Schedule represents the availability container for a provider.  In OpenEMR, availability
 * is stored as `openemr_postcalendar_events` rows with `pc_pid = 0`.  One Schedule resource is
 * returned per provider who has at least one such block; its `planningHorizon` spans the earliest
 * and latest block dates for that provider.
 *
 * Schedule UUID = provider UUID (1:1 mapping, no extra table storage required).
 *
 * Supported search parameters:
 *   _id    — Schedule UUID (= provider UUID)
 *   actor  — Reference to Practitioner or Person, e.g. Practitioner/{uuid}
 *   date   — Filters providers whose planning horizon overlaps the given date/range
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
use OpenEMR\FHIR\R4\FHIRDomainResource\FHIRSchedule;
use OpenEMR\FHIR\R4\FHIRElement\FHIRBoolean;
use OpenEMR\FHIR\R4\FHIRElement\FHIRId;
use OpenEMR\FHIR\R4\FHIRElement\FHIRInstant;
use OpenEMR\FHIR\R4\FHIRElement\FHIRMeta;
use OpenEMR\FHIR\R4\FHIRElement\FHIRPeriod;
use OpenEMR\FHIR\R4\FHIRElement\FHIRReference;
use OpenEMR\FHIR\R4\FHIRElement\FHIRString;
use OpenEMR\Services\FHIR\Traits\FhirServiceBaseEmptyTrait;
use OpenEMR\Services\Search\FhirSearchParameterDefinition;
use OpenEMR\Services\Search\SearchFieldType;
use OpenEMR\Services\Search\ServiceField;
use OpenEMR\Validators\ProcessingResult;

class FhirScheduleService extends FhirServiceBase
{
    use FhirServiceBaseEmptyTrait;

    /**
     * @inheritDoc
     */
    protected function loadSearchParameters()
    {
        return [
            '_id' => new FhirSearchParameterDefinition(
                '_id',
                SearchFieldType::TOKEN,
                [new ServiceField('provider_uuid', ServiceField::TYPE_UUID)]
            ),
            'actor' => new FhirSearchParameterDefinition(
                'actor',
                SearchFieldType::TOKEN,
                [new ServiceField('provider_uuid', ServiceField::TYPE_UUID)]
            ),
            'date' => new FhirSearchParameterDefinition(
                'date',
                SearchFieldType::DATE,
                ['horizon_start']
            ),
        ];
    }

    /**
     * @inheritDoc
     */
    public function parseOpenEMRRecord($dataRecord = [], $encode = false)
    {
        $schedule = new FHIRSchedule();

        $meta = new FHIRMeta();
        $meta->setVersionId("1");
        $schedule->setMeta($meta);

        // Schedule ID equals the provider UUID (stable, no extra storage)
        $id = new FHIRId();
        $id->setValue($dataRecord['provider_uuid']);
        $schedule->setId($id);

        $active = new FHIRBoolean();
        $active->setValue(true);
        $schedule->setActive($active);

        // Actor — Practitioner if NPI present, otherwise Person
        $actorRef = new FHIRReference();
        $resourceType = !empty($dataRecord['provider_npi']) ? 'Practitioner' : 'Person';
        $actorRef->setReference("{$resourceType}/{$dataRecord['provider_uuid']}");
        $displayName = trim(($dataRecord['provider_fname'] ?? '') . ' ' . ($dataRecord['provider_lname'] ?? ''));
        if ($displayName !== '') {
            $actorRef->setDisplay($displayName);
        }
        $schedule->addActor($actorRef);

        // Planning horizon covers the full span of the provider's availability blocks
        if (!empty($dataRecord['horizon_start'])) {
            $period = new FHIRPeriod();
            $period->setStart(new FHIRInstant(
                UtilsService::getLocalDateAsUTC($dataRecord['horizon_start'] . ' 00:00:00')
            ));
            if (!empty($dataRecord['horizon_end']) && $dataRecord['horizon_end'] !== '0000-00-00') {
                $period->setEnd(new FHIRInstant(
                    UtilsService::getLocalDateAsUTC($dataRecord['horizon_end'] . ' 23:59:59')
                ));
            }
            $schedule->setPlanningHorizon($period);
        }

        $comment = new FHIRString();
        $comment->setValue('Provider availability schedule');
        $schedule->setComment($comment);

        if ($encode) {
            return json_encode($schedule);
        }
        return $schedule;
    }

    /**
     * @inheritDoc
     */
    protected function searchForOpenEMRRecords($openEMRSearchParameters): ProcessingResult
    {
        $processingResult = new ProcessingResult();

        $providerUuid = $this->extractProviderUuid($openEMRSearchParameters);
        $dateConstraints = $this->extractDateConstraints($openEMRSearchParameters);

        $sql = "SELECT
                    LOWER(CONCAT(
                        SUBSTR(HEX(u.uuid), 1,  8), '-',
                        SUBSTR(HEX(u.uuid), 9,  4), '-',
                        SUBSTR(HEX(u.uuid), 13, 4), '-',
                        SUBSTR(HEX(u.uuid), 17, 4), '-',
                        SUBSTR(HEX(u.uuid), 21, 12)
                    ))                                             AS provider_uuid,
                    u.id                                           AS provider_id,
                    u.npi                                          AS provider_npi,
                    u.fname                                        AS provider_fname,
                    u.lname                                        AS provider_lname,
                    MIN(pce.pc_eventDate)                          AS horizon_start,
                    MAX(
                        CASE
                            WHEN pce.pc_endDate = '0000-00-00' OR pce.pc_endDate IS NULL
                                THEN pce.pc_eventDate
                            ELSE pce.pc_endDate
                        END
                    )                                              AS horizon_end
                FROM users u
                INNER JOIN openemr_postcalendar_events pce
                    ON pce.pc_aid = u.id AND pce.pc_pid = 0
                WHERE u.active = 1";

        $bindArray = [];

        if ($providerUuid !== null) {
            $sql .= " AND u.uuid = ?";
            $bindArray[] = UuidRegistry::uuidToBytes($providerUuid);
        }

        // Apply date-range filter against the availability blocks
        foreach ($dateConstraints as [$comparator, $date]) {
            switch ($comparator) {
                case 'ge':
                case 'gt':
                    $sql .= " AND pce.pc_eventDate >= ?";
                    $bindArray[] = $date;
                    break;
                case 'le':
                case 'lt':
                    $sql .= " AND pce.pc_eventDate <= ?";
                    $bindArray[] = $date;
                    break;
                default:
                    // eq — horizon must include this date
                    $sql .= " AND pce.pc_eventDate <= ? AND CASE WHEN pce.pc_endDate = '0000-00-00' OR pce.pc_endDate IS NULL THEN pce.pc_eventDate ELSE pce.pc_endDate END >= ?";
                    $bindArray[] = $date;
                    $bindArray[] = $date;
            }
        }

        $sql .= " GROUP BY u.uuid, u.id, u.npi, u.fname, u.lname";

        $records = QueryUtils::fetchRecords($sql, $bindArray);
        foreach ($records as $record) {
            $processingResult->addData($record);
        }

        return $processingResult;
    }

    /**
     * @inheritDoc
     */
    public function createProvenanceResource($dataRecord, $encode = false)
    {
        // Schedule is a system-generated resource; provenance is not tracked at this level
        return null;
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    /**
     * Extract a bare provider UUID string from _id or actor search fields.
     * Handles both "Practitioner/{uuid}" reference format and plain UUID.
     */
    private function extractProviderUuid(array $searchParameters): ?string
    {
        foreach (['_id', 'actor'] as $key) {
            if (empty($searchParameters[$key])) {
                continue;
            }
            $field = $searchParameters[$key];
            $values = method_exists($field, 'getValues') ? $field->getValues() : [];
            if (empty($values)) {
                continue;
            }
            $raw = method_exists($values[0], 'getValue') ? (string) $values[0]->getValue() : (string) $values[0];
            if ($raw === '') {
                continue;
            }
            // Strip resource-type prefix: "Practitioner/uuid" → "uuid"
            if (strpos($raw, '/') !== false) {
                $raw = substr($raw, strrpos($raw, '/') + 1);
            }
            return $raw;
        }
        return null;
    }

    /**
     * Extract date comparator/value pairs from the `date` search parameter.
     * @return array<int, array{0: string, 1: string}>
     */
    private function extractDateConstraints(array $searchParameters): array
    {
        $constraints = [];
        if (empty($searchParameters['date'])) {
            return $constraints;
        }
        $field = $searchParameters['date'];
        $values = method_exists($field, 'getValues') ? $field->getValues() : [];
        foreach ($values as $v) {
            $comparator = method_exists($v, 'getComparator') ? $v->getComparator() : 'eq';
            $value = method_exists($v, 'getValue') ? (string) $v->getValue() : (string) $v;
            // Trim to date portion if a full datetime was supplied
            if (strlen($value) > 10) {
                $value = substr($value, 0, 10);
            }
            if ($value !== '') {
                $constraints[] = [$comparator, $value];
            }
        }
        return $constraints;
    }
}
