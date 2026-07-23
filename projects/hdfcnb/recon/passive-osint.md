# Recon — Passive OSINT (task 1)

Engagement: hdfcnb1 · HDFC Net Banking UAT · ref HDFC-STANDING-AUTH-2026-07
Date: 2026-07-23 · Method: passive only, ZERO active touch on target.

## DNS / infrastructure
Both in-scope hosts resolve **publicly** and front **AWS ALBs in ap-south-1 (Mumbai)**:

| Host | CNAME (ALB) | IPs |
|------|-------------|-----|
| nb-nextgen-sit.hdfcbank.com | nwinfra-inbound-uat-nextgen-alb-474192871.ap-south-1.elb.amazonaws.com | 13.126.30.31, 65.2.201.246 |
| nb-nextgen-sit2.hdfcbank.com | nwinfra-inbound-nextgen-dm1-alb-305573195.ap-south-1.elb.amazonaws.com | 65.2.7.149, 3.109.67.93 |

Observations:
- Hosting: **AWS (Amazon), ASN AS16509 / ap-south-1**. IPs are AWS-owned (ALB) — do NOT
  port-scan the raw EC2/AWS range as a target; test only the app behind the ALB (in scope).
- Naming: `nwinfra-inbound-*` = network-infra inbound tier. sit → `uat-nextgen`,
  sit2 → `nextgen-dm1` (dm1 likely a DMZ tier). Two distinct ALBs = two distinct env builds
  → enumerate + diff both (SIT vs SIT2) per coverage plan.
- Public exposure of a UAT banking env is itself notable for the report (attack surface).

## Certificate Transparency (subdomain enum)
- crt.sh **unavailable this pass (HTTP 502 x2)** — external outage, deferred.
- Sibling-subdomain enum will be recovered from the live **TLS cert SANs** in task 2
  (infra fingerprint) and re-attempted at crt.sh in a later pass.

## Archives (Wayback)
- `nb-nextgen-sit.hdfcbank.com` → only root `/` archived. No historical path leakage.
- `nb-nextgen-sit2.hdfcbank.com` → nothing archived.
- Low archive footprint → path discovery must come from live crawl + JS parse (tasks 3–4).

## Dorks / public leaks
- Google/GitHub automated dorking not run (needs API keys / manual). Flagged for manual
  GitHub code-search on `nb-nextgen` / `hdfcbank` + these ALB names by the tester.

## Feeds into ledger
Seeds `endpoints.csv`: 2 hosts, root `/` each, source=passive. Everything else pending
active discovery (tasks 3–5).

## Deferred / follow-ups
- [ ] crt.sh CT enum (retry when service up) — task 2 partially covers via SANs.
- [ ] Manual GitHub/Google dork pass (tester).
