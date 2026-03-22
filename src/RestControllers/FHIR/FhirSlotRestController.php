<?php

/**
 * FhirSlotRestController
 *
 * Exposes computed FHIR R4 Slot resources derived from provider availability blocks.
 * Slots are generated on-the-fly; the primary access pattern is search (not individual
 * GET by UUID).
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    PolarisAiAgent
 * @copyright Copyright (c) 2025 PolarisAiAgent
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

namespace OpenEMR\RestControllers\FHIR;

use OpenApi\Attributes as OA;
use OpenEMR\Common\Http\HttpRestRequest;
use OpenEMR\Core\OEGlobalsBag;
use OpenEMR\FHIR\R4\FHIRResource\FHIRBundle\FHIRBundleEntry;
use OpenEMR\RestControllers\RestControllerHelper;
use OpenEMR\Services\FHIR\FhirSlotService;
use OpenEMR\Services\FHIR\FhirResourcesService;

class FhirSlotRestController
{
    private readonly FhirSlotService $fhirSlotService;
    private readonly FhirResourcesService $fhirService;

    public function __construct(HttpRestRequest $request)
    {
        $this->fhirSlotService = new FhirSlotService($request->getApiBaseFullUrl());
        $this->fhirService = new FhirResourcesService();
    }

    /**
     * Returns a single FHIR Slot resource by its deterministic UUID.
     *
     * Note: Because Slot UUIDs are computed rather than stored, this endpoint requires
     * the `schedule` query parameter to be provided alongside the UUID to narrow the
     * provider search scope. Without it the lookup performs a full provider scan and
     * may be slow in large deployments.
     */
    #[OA\Get(
        path: '/fhir/Slot/{uuid}',
        description: 'Returns a single Slot resource by its deterministic UUID.',
        tags: ['fhir'],
        parameters: [
            new OA\Parameter(
                name: 'uuid',
                in: 'path',
                description: 'The deterministic Slot UUID.',
                required: true,
                schema: new OA\Schema(type: 'string')
            ),
        ],
        responses: [
            new OA\Response(response: '200', description: 'Standard Response'),
            new OA\Response(response: '400', ref: '#/components/responses/badrequest'),
            new OA\Response(response: '401', ref: '#/components/responses/unauthorized'),
            new OA\Response(response: '404', ref: '#/components/responses/uuidnotfound'),
        ],
        security: [['openemr_auth' => []]]
    )]
    public function getOne(string $fhirId): mixed
    {
        $processingResult = $this->fhirSlotService->getOne($fhirId);
        return RestControllerHelper::handleFhirProcessingResult($processingResult, 200);
    }

    /**
     * Returns a FHIR Bundle of Slot resources for a provider's availability.
     *
     * The most efficient query pattern is:
     *   GET /fhir/Slot?schedule=Schedule/{provider_uuid}&start=ge2026-04-06&start=le2026-04-06&status=free
     *
     * Supported query parameters:
     *   schedule — Schedule reference (= provider UUID), e.g. Schedule/{uuid}  [recommended]
     *   start    — Date range for slot start time (ge, le, eq modifiers)       [recommended]
     *   status   — free | busy | busy-unavailable | busy-tentative
     *   _id      — Deterministic slot UUID
     */
    #[OA\Get(
        path: '/fhir/Slot',
        description: 'Returns free and busy Slot resources computed from provider availability blocks.',
        tags: ['fhir'],
        parameters: [
            new OA\Parameter(
                name: 'schedule',
                in: 'query',
                description: 'Schedule reference, e.g. Schedule/{provider_uuid}.',
                required: false,
                schema: new OA\Schema(type: 'string')
            ),
            new OA\Parameter(
                name: 'start',
                in: 'query',
                description: 'Date range for slot start (supports ge/le/eq). Repeat for range.',
                required: false,
                schema: new OA\Schema(type: 'string')
            ),
            new OA\Parameter(
                name: 'status',
                in: 'query',
                description: 'Filter by status: free | busy.',
                required: false,
                schema: new OA\Schema(type: 'string')
            ),
        ],
        responses: [
            new OA\Response(response: '200', description: 'Standard Response'),
            new OA\Response(response: '400', ref: '#/components/responses/badrequest'),
            new OA\Response(response: '401', ref: '#/components/responses/unauthorized'),
        ],
        security: [['openemr_auth' => []]]
    )]
    public function getAll(array $searchParams): mixed
    {
        $processingResult = $this->fhirSlotService->getAll($searchParams);
        $bundleEntries = [];
        foreach ($processingResult->getData() as $searchResult) {
            $bundleEntry = [
                'fullUrl' => OEGlobalsBag::getInstance()->get('site_addr_oath')
                    . ($_SERVER['REDIRECT_URL'] ?? '')
                    . '/' . $searchResult->getId(),
                'resource' => $searchResult,
            ];
            $bundleEntries[] = new FHIRBundleEntry($bundleEntry);
        }
        $bundleSearchResult = $this->fhirService->createBundle('Slot', $bundleEntries, false);
        return RestControllerHelper::responseHandler($bundleSearchResult, null, 200);
    }
}
