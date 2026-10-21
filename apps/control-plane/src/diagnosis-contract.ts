export type DiagnosisResult = {
  model: string;
  modelVersion: string;
  diagnosedAt: string;
  diagnosis: string;
  rationale: string;
  selectedOfferId: string;
  paymentExecuted: false;
  comparisonOnly: true;
  offers: Array<{
    offerId: string;
    priceUsdc: string;
    latencyMs: number | null;
    expiresAt: string;
    expired: boolean;
  }>;
};
