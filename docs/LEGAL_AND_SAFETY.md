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
  Tridium, Honeywell, Anthropic, OpenAI, Claude, Codex, the Official MCP
  Registry, or any MCP client vendor.
- Use least-privilege Niagara users for external clients and AI workflows.
- Keep MCP point writes, alarm actions, and raw operations disabled unless an
  authorized operator explicitly intends that access.

## Distribution Review

Before public distribution or marketplace submission:

- Confirm the repository license is intentional.
- Confirm `NOTICE.md`, `docs/PRIVACY.md`, and `docs/TERMS.md` match the actual
  distribution model.
- Confirm no Tridium/Honeywell proprietary files, license keys, generated
  binary internals, or confidential security/performance materials are included.
- Confirm plugin and MCP descriptions avoid third-party endorsement language.
- Run MCP startup checks with raw operations disabled.

## References

- Tridium Niagara EULA: https://www.tridium.com/us/en/eula
- MCP security best practices: https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices
- MCP Registry Terms: https://modelcontextprotocol.io/registry/terms-of-service
- DOJ CFAA guidance: https://www.justice.gov/jm/jm-9-48000-computer-fraud
