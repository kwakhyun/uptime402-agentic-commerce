import "server-only";

// Keep the Node-only egress implementation below the control-plane layer so
// the vendor facilitator and A2A buyer share one connect-time DNS/IP policy
// without either deployable importing the other.
export {
  createExplicitLocalHttpTestFetchFactory,
  createProductionOriginBoundFetchFactory,
  isPublicInternetAddress,
  type ExplicitLocalHttpTestFetchOptions,
  type OriginBoundFetchFactory,
  type OriginBoundHttpsRequest,
  type OriginBoundResolver,
  type ProductionOriginBoundFetchOptions,
  type ResolvedPublicAddress,
} from "@uptime402/payments";
