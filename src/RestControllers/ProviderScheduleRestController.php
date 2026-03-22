<?php

/**
 * ProviderScheduleRestController
 *
 * Returns schedule blocks (provider availability windows, pc_pid = 0) for a
 * given provider UUID.  Used by the OpenEMR Health MCP server so that
 * health_check_slots can build availability from real calendar data instead of
 * a hardcoded 08:00–17:00 window.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    PolarisAiAgent
 * @copyright Copyright (c) 2025 PolarisAiAgent
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

namespace OpenEMR\RestControllers;

use OpenEMR\Common\Database\QueryUtils;
use OpenEMR\RestControllers\RestControllerHelper;
use OpenEMR\Services\AppointmentService;
use OpenEMR\Validators\ProcessingResult;

class ProviderScheduleRestController
{
    private AppointmentService $appointmentService;

    public function __construct()
    {
        $this->appointmentService = new AppointmentService();
    }

    /**
     * Returns schedule availability blocks for a provider.
     *
     * GET /api/provider/:pruuid/schedule?date_start=YYYY-MM-DD&date_end=YYYY-MM-DD
     *
     * @param string $pruuid     Provider UUID or numeric ID
     * @param array  $getParams  Query parameters (date_start, date_end)
     * @return array             REST response envelope
     */
    public function getSchedule(string $pruuid, array $getParams = []): array
    {
        // Resolve pruuid → numeric provider ID
        $providerId = $this->resolveProviderId($pruuid);
        if ($providerId === null) {
            $result = new ProcessingResult();
            $result->setValidationMessages(['pruuid' => 'Provider not found: ' . $pruuid]);
            return RestControllerHelper::responseHandler($result, null, 404);
        }

        $dateStart = $getParams['date_start'] ?? '';
        $dateEnd   = $getParams['date_end']   ?? '';

        // Basic date format validation
        foreach (['date_start' => $dateStart, 'date_end' => $dateEnd] as $param => $value) {
            if (!empty($value) && !preg_match('/^\d{4}-\d{2}-\d{2}$/', $value)) {
                $result = new ProcessingResult();
                $result->setValidationMessages([$param => "Must be YYYY-MM-DD, got: $value"]);
                return RestControllerHelper::responseHandler($result, null, 400);
            }
        }

        $blocks = $this->appointmentService->getProviderScheduleBlocks($providerId, $dateStart, $dateEnd);

        $processingResult = new ProcessingResult();
        $processingResult->addData([
            'provider_id' => $providerId,
            'provider_uuid' => $pruuid,
            'date_start' => $dateStart ?: null,
            'date_end' => $dateEnd ?: null,
            'count' => count($blocks),
            'schedule_blocks' => $blocks,
        ]);

        return RestControllerHelper::responseHandler($processingResult, null, 200);
    }

    /**
     * Resolves a provider UUID or numeric ID string to the numeric users.id.
     */
    private function resolveProviderId(string $pruuid): ?int
    {
        // If it looks like a plain integer, use it directly after verifying existence
        if (ctype_digit($pruuid)) {
            $id = QueryUtils::fetchSingleValue(
                'SELECT id FROM users WHERE id = ? AND active = 1',
                'id',
                [(int) $pruuid]
            );
            return $id !== null ? (int) $id : null;
        }

        // Otherwise treat as UUID
        $id = QueryUtils::fetchSingleValue(
            'SELECT id FROM users WHERE uuid = ? AND active = 1',
            'id',
            [$pruuid]
        );
        return $id !== null ? (int) $id : null;
    }
}
