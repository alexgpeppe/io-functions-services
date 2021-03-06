import * as express from "express";

import * as t from "io-ts";

import {
  ClientIp,
  ClientIpMiddleware
} from "io-functions-commons/dist/src/utils/middlewares/client_ip_middleware";

import { RequiredParamMiddleware } from "io-functions-commons/dist/src/utils/middlewares/required_param";

import { IResponseErrorQuery } from "io-functions-commons/dist/src/utils/response";

import {
  AzureApiAuthMiddleware,
  IAzureApiAuthorization,
  UserGroup
} from "io-functions-commons/dist/src/utils/middlewares/azure_api_auth";
import {
  AzureUserAttributesMiddleware,
  IAzureUserAttributes
} from "io-functions-commons/dist/src/utils/middlewares/azure_user_attributes";
import {
  withRequestMiddlewares,
  wrapRequestHandler
} from "io-functions-commons/dist/src/utils/request_middleware";
import {
  IResponseErrorForbiddenNotAuthorized,
  IResponseErrorInternal,
  IResponseErrorNotFound,
  IResponseErrorValidation,
  IResponseSuccessJson,
  ResponseErrorNotFound,
  ResponseSuccessJson
} from "italia-ts-commons/lib/responses";
import { PatternString } from "italia-ts-commons/lib/strings";

import {
  checkSourceIpForHandler,
  clientIPAndCidrTuple as ipTuple
} from "io-functions-commons/dist/src/utils/source_ip_check";

import { ServiceModel } from "io-functions-commons/dist/src/models/service";

import { TableService } from "azure-storage";

import { DateUTC } from "../generated/definitions/DateUTC";
import { FiscalCodeHash } from "../generated/definitions/FiscalCodeHash";
import { SubscriptionsFeed } from "../generated/definitions/SubscriptionsFeed";

import {
  getPagedQuery,
  PagedQuery,
  queryFilterForKey,
  queryUsers
} from "./utils";

/**
 * Type of a GetSubscriptionsFeed handler.
 */
type IGetSubscriptionsFeedHandler = (
  auth: IAzureApiAuthorization,
  clientIp: ClientIp,
  attrs: IAzureUserAttributes,
  date: string
) => Promise<
  // tslint:disable-next-line:max-union-size
  | IResponseSuccessJson<SubscriptionsFeed>
  | IResponseErrorNotFound
  | IResponseErrorQuery
  | IResponseErrorValidation
  | IResponseErrorForbiddenNotAuthorized
  | IResponseErrorInternal
>;

/**
 * Handles requests for getting a single message for a recipient.
 */
export function GetSubscriptionsFeedHandler(
  tableService: TableService,
  subscriptionsFeedTable: string
): IGetSubscriptionsFeedHandler {
  return async (_, __, userAttributes, subscriptionsDateUTC) => {
    // subscription data for a certain day becomes available at the begining of
    // the next day
    const availableSince =
      new Date(`${subscriptionsDateUTC}T00:00:00Z`).getTime() +
      24 * 60 * 60 * 1000;

    if (Date.now() < availableSince) {
      return ResponseErrorNotFound(
        "Data not available yet",
        `Subscription data for ${subscriptionsDateUTC} will be available from ${new Date(
          availableSince
        ).toUTCString()}`
      );
    }

    const { serviceId } = userAttributes.service;

    // get a function that can query the subscriptions table
    const pagedQuery = getPagedQuery(tableService, subscriptionsFeedTable);

    // querying for a partition key will get us all entries associated to that
    // partition key - partition key contains the requested date, meaning we're
    // querying for subscription events happenend on that day
    const profileSubscriptionsQuery: PagedQuery = pagedQuery(
      queryFilterForKey(`P-${subscriptionsDateUTC}-S`)
    );
    const serviceSubscriptionsQuery: PagedQuery = pagedQuery(
      queryFilterForKey(`S-${subscriptionsDateUTC}-${serviceId}-S`)
    );
    const serviceUnsubscriptionsQuery: PagedQuery = pagedQuery(
      queryFilterForKey(`S-${subscriptionsDateUTC}-${serviceId}-U`)
    );

    // users that created their account on date
    const profileSubscriptionsSet = await queryUsers(profileSubscriptionsQuery);

    // users that subscribed to the client service on date
    const serviceSubscriptionsSet = await queryUsers(serviceSubscriptionsQuery);

    // users that unsubscribed from the client service on date
    const serviceUnsubscriptionsSet = await queryUsers(
      serviceUnsubscriptionsQuery
    );

    const subscriptions = new Array<FiscalCodeHash>();
    profileSubscriptionsSet.forEach(ps => {
      if (!serviceUnsubscriptionsSet.has(ps)) {
        // add new users to the new subscriptions, skipping those that
        // unsubscribed from this service
        subscriptions.push(ps);
      }
    });
    serviceSubscriptionsSet.forEach(ss => {
      if (!profileSubscriptionsSet.has(ss)) {
        // add all users that subscribed to this service, skipping those that
        // are new users as they're yet counted in as new subscribers in the
        // previous step
        subscriptions.push(ss);
      }
    });

    const unsubscriptions = new Array<FiscalCodeHash>();
    serviceUnsubscriptionsSet.forEach(su => {
      if (!profileSubscriptionsSet.has(su)) {
        // add all users that unsubscribed from this service, skipping those
        // that created the profile on the same day as the service will not
        // yet know they exist
        unsubscriptions.push(su);
      }
    });

    const feedJson = {
      dateUTC: subscriptionsDateUTC as DateUTC,
      subscriptions,
      unsubscriptions
    } as SubscriptionsFeed;

    return ResponseSuccessJson(feedJson);
  };
}

/**
 * A string that represents a date in the format YYYY-MM-DD
 */
const ShortDateString = t.refinement(
  PatternString("\\d\\d\\d\\d-\\d\\d-\\d\\d"),
  s => !isNaN(new Date(s).getTime()),
  "ShortDateString"
);

/**
 * Wraps a GetMessage handler inside an Express request handler.
 */
export function GetSubscriptionsFeed(
  serviceModel: ServiceModel,
  tableService: TableService,
  subscriptionsFeedTable: string
): express.RequestHandler {
  const handler = GetSubscriptionsFeedHandler(
    tableService,
    subscriptionsFeedTable
  );
  const middlewaresWrap = withRequestMiddlewares(
    AzureApiAuthMiddleware(new Set([UserGroup.ApiSubscriptionsFeedRead])),
    ClientIpMiddleware,
    AzureUserAttributesMiddleware(serviceModel),
    RequiredParamMiddleware("date", ShortDateString)
  );
  return wrapRequestHandler(
    middlewaresWrap(
      checkSourceIpForHandler(handler, (_, c, u, __) => ipTuple(c, u))
    )
  );
}
