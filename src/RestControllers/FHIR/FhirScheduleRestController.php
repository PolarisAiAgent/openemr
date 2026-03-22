<?php

/**
 * FhirScheduleRestController
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
use OpenEMR\Services\FHIR\FhirScheduleService;
use OpenEMR\Services\FHIR\FhirResourcesService;

class FhirScheduleRestController
{
    private readonly FhirScheduleService $fhirScheduleService;
    private readonly FhirResourcesService $fhirService;

    public function __construct(HttpRestRequest $request)
    {
        $this->fhirScheduleService = new FhirScheduleService($request->getApiBaseFullUrl());
        $this->fhirService = new FhirResourcesService();
    }

    /**
     * Returns a single FHIR Schedule resource by UUID (= provider UUID).
     */
    #[OA\Get(
        path: '/fhir/Schedule/{uuid}',
        description: 'Returns a single Schedule resource representing a provider availability schedule.',
        tags: ['fhir'],
        parameters: [
            new OA\Parameter(
                name: 'uuid',
                in: 'path',
                description: 'The provider UUID that identifies the Schedule.',
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
        $processingResult = $this->fhirScheduleService->getOne($fhirId);
        return RestControllerHelper::handleFhirProcessingResult($processingResult, 200);
    }

    /**
     * Returns a FHIR Bundle of Schedule resources matching the given search parameters.
     *
     * Supported query parameters:
     *   _id     — Schedule UUID (= provider UUID)
     *   actor   — Reference to a Practitioner, e.g. Practitioner/{uuid}
     *   date    — Date range filter on the planning horizon (ge, le, eq modifiers)
     */
    #[OA\Get(
        path: '/fhir/Schedule',
        description: 'Returns a list of Schedule resources for providers who have availability blocks configured.',
        tags: ['fhir'],
        parameters: [
            new OA\Parameter(
                name: '_id',
                in: 'query',
                description: 'The Schedule UUID (equals the provider UUID).',
                required: false,
                schema: new OA\Schema(type: 'string')
            ),
            new OA\Parameter(
                name: 'actor',
                in: 'query',
                description: 'Provider reference, e.g. Practitioner/{uuid}.',
                required: false,
                schema: new OA\Schema(type: 'string')
            ),
            new OA\Parameter(
                name: 'date',
                in: 'query',
                description: 'Filter by planning horizon date (supports ge/le/eq).',
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
        $processingResult = $this->fhirScheduleService->getAll($searchParams);
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
        $bundleSearchResult = $this->fhirService->createBundle('Schedule', $bundleEntries, false);
        return RestControllerHelper::responseHandler($bundleSearchResult, null, 200);
    }
}
