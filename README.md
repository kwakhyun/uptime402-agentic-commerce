# Uptime402 Codex harness

This folder is a portable starter harness for a new Codex project. Codex discovers repository skills under `.agents/skills`.

1. Copy the **contents** of this folder into the new project root, including the hidden `.agents/` directory and `AGENTS.md`.
2. Open that project in Codex.
3. Confirm that `$ship-agentic-commerce-finalist` appears in the skill selector. Codex detects skill changes automatically; restart it if the skill does not appear.
4. Paste the contents of `FIRST_PROMPT.md` as the first task.

On macOS or Linux, run this from the harness directory. `cp -R .` copies hidden files too; replace only the destination:

```bash
cd "/absolute/path/to/uptime402-codex-harness"
TARGET_PROJECT="/absolute/path/to/new-project"
mkdir -p "$TARGET_PROJECT"
cp -R . "$TARGET_PROJECT/"
test -f "$TARGET_PROJECT/.agents/skills/ship-agentic-commerce-finalist/SKILL.md"
```

This merges into an existing destination and can overwrite same-named harness files. Use an empty new project directory or review the destination first.

## Preflight inputs

Codex can scaffold adapters, tests, docs, and the local demo before these exist. A real payment or deployment needs the corresponding user-controlled input.

| Input | Needed for | Safe handoff |
|---|---|---|
| Node.js, package manager, Git, Python 3 | local build and checker | install locally; no secret |
| Gemini API key or Vertex AI identity | live structured diagnosis | put it in an ignored local env file or Secret Manager; tell Codex only the variable name |
| Existing low-balance Devnet executor wallet with fee SOL and Devnet USDC | real autonomous payment spike | place the key only in an ignored local file/secret store; never paste it into chat, source, fixtures, or evidence |
| Distinct vendor USDC recipient plus receipt-signing identity | non-self payment and signed fulfillment evidence | external vendor supplies `payTo` in a verified signed offer; for the owned fallback, provide `VENDOR_USDC_RECIPIENT` and a separate receipt-key path in Secret Manager |
| Solana Devnet RPC and verified x402 facilitator | settlement and independent RPC verification | use config/env variables; pin current official network/mint values after a live check |
| Google Cloud project, billing permission, authenticated CLI, enabled APIs | Cloud Run, Firestore, Secret Manager | the user creates/selects the project and approves chargeable deployment; use distinct least-privilege service accounts |
| Judge-accessible GitHub destination and final video publication | final submission | the user authorizes repository/video publication and supplies the final video if Codex cannot record or upload it |

The organizer-provided Google Cloud path assumes an eligible personal account, billing verification, and the $300/90-day free program. Gemini API/AI Studio billing is separate from that welcome credit, so prefer its available free tier or an explicitly eligible Vertex/Gemini billing path.

If the Devnet wallet or USDC is missing, the first task must stop only at the real-payment boundary and request the exact funding/credential action. It must not create a wallet, expose a key, substitute a fake transaction, or silently use Mainnet.

The skill freezes the finalist-oriented product brief, forces an evidence-first build order, guards wallet and protocol claims, validates required submission artifacts, and keeps the implementation focused on a real Devnet USDC payment rather than a broad mockup.

Key files:

- `FINALIST_BLUEPRINT.md`: product and submission strategy.
- `FIRST_PROMPT.md`: the first prompt for the new Codex project.
- `.agents/skills/ship-agentic-commerce-finalist/`: the reusable project skill.
- `.agents/skills/ship-agentic-commerce-finalist/references/payment-evidence-v2.md`: the normative evidence contract.
- `AGENTS.md`: repository-wide guardrails and priorities.

The readiness checker has separate structural and submission gates. Run the structural gate early with `python3 .agents/skills/ship-agentic-commerce-finalist/scripts/check_finalist_readiness.py --root . --strict`. The final gate adds `--submission --run-repo-scripts`, the explicit Devnet USDC mint, and a real RPC; it cannot be replaced by a base58-shaped fixture. See the skill for the exact public/private RPC commands and manually review every `manual.*` result.
