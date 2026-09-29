# Legal And Safety Checklist

This is engineering guidance, not legal advice. Review the current Tridium
Niagara EULA, the target license/order terms, customer agreements, and local
law before distributing or using this project on third-party systems.

## Required Boundaries

- Use baskStream only with Niagara stations and software licenses you are
  authorized to access and administer.
- Keep the Niagara module additive. Do not modify Niagara binary behavior,
  license files, security devices, access logs, or APIs.
- Do not reverse engineer, decompile, disassemble, decrypt, extract, or
  reproduce Niagara Framework internals.
- Do not copy Tridium source code, decompiled code, proprietary documentation,
  license keys, vulnerability findings, benchmark results, or confidential
  evaluation results into this repository or AI prompts.
- Do not imply endorsement, certification, sponsorship, or partnership with
  Tridium, Honeywell, Anthropic, OpenAI, or any AI tool vendor.
- Use least-privilege Niagara users for external clients.
- Keep point writes, alarm actions, and model edits disabled in clients (for
  example, run bask without `--allow-writes`) unless an authorized operator
  explicitly intends that access.

## Distribution Review

Before public distribution or marketplace submission:

- Confirm the repository license is intentional.
- Confirm `NOTICE.md`, `docs/PRIVACY.md`, and `docs/TERMS.md` match the actual
  distribution model.
- Confirm no Tridium/Honeywell proprietary files, license keys, generated
  binary internals, or confidential security/performance materials are included.
- Confirm project and release descriptions avoid third-party endorsement
  language.

## References

- Tridium Niagara EULA: https://www.tridium.com/us/en/eula
- DOJ CFAA guidance: https://www.justice.gov/jm/jm-9-48000-computer-fraud
