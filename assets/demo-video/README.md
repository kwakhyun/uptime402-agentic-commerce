# Uptime402 demo replay inputs

The tracked manifest `finalist-demo-5.replay.json` defines a deterministic
165-second video, but it intentionally contains no placeholder screenshots and
cannot produce a final artifact in its checked-in `template` stage.

Place real, final-stage UI captures in the ignored directory:

```text
private/demo-video-inputs/finalist-demo-5/
  01-overview-final.png
  02-mandate.png
  03-run-binding.png
  04-gemini-offers.png
  05-x402-round-trip.png
  06-chain-evidence.png
  07-receipt-recovery.png
  08-dual-denial.png
  09-cloud-boundary.png
  10-closing.png
```

Every capture must come from the hash-pinned `final` UI or another public,
hash-bound read-only evidence view. Do not capture a new incident, click the
operator trigger, resend a paid retry, or expose raw payment payloads, auth
tokens, terminal output, Secret Manager values, key material, or internal Codex
screens.

Copy the manifest into `private/demo-video-work/`, change `stage` to `final`,
and fill these values only after evidence verification and final deployment:

- `evidenceSha256`
- `verificationReportSha256`
- `sourceGitSha` for the deployed final UI/images
- every `imageSha256`

The final guard verifies those hashes and the exact demo5 payment, selection,
token delta, budget, and denial facts against `payment-evidence.json`.
