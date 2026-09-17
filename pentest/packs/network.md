<!-- SCH Loop method body for domains: external-network, internal-network. Infra/network VAPT. Authorization via the scope gate. Coverage-as-contract: every in-scope host/service tested or tested-clean. Read knowledge before, sch-learn after. -->

# Autonomous Network Penetration Test — external + internal

Authorized network/infra pentest under a signed `SCOPE.md` (in-scope IP ranges /
hosts / CIDRs only). Orchestrator model. **Only touch hosts inside the scope
gate** — re-check `scope-check` before every active task. Never DoS; probe safely.

## Box type
- **Black** — only the ranges given; discover from zero.
- **Gray** — + a foothold / creds / asset list (internal assumed-breach default).
- **White** — + full asset inventory / configs.

## External network (`external-network`)
1. **Recon** — OSINT, ASN/IP ranges, DNS, exposed services, cert transparency.
2. **Discovery & enum** — host discovery, full TCP/UDP port scan, service +
   version fingerprint, banner grab. Skills: `scanning-network-with-nmap-advanced`.
3. **Vuln assessment** — map services → known CVEs, misconfig, default creds,
   exposed admin/VPN/RDP/SMB, weak TLS. Skill: `performing-authenticated-scan-with-openvas`.
4. **Exploitation** — validate real, exploitable issues with a PoC (safe checks
   first; no destructive exploits). Skill: `exploiting-vulnerabilities-with-metasploit-framework`.
5. **Post-exploitation** — only within scope + RoE; prove impact, no lateral
   movement outside scope.
6. **Report** — coverage matrix (host×service), findings + CVSS + PoC, remediation.

## Internal network (`internal-network`) — assumed breach
1. **Recon** — from the foothold: subnet/host discovery, live hosts, services.
2. **Discovery & enum** — SMB/LDAP/NFS/SNMP enum, shares, null sessions.
3. **AD enumeration** — users, groups, GPOs, ACLs, trusts, attack paths.
   Skills: `conducting-internal-reconnaissance-with-bloodhound-ce`,
   `mapping-attack-paths-with-bloodhound-ce`, `performing-active-directory-penetration-test`.
4. **Vuln assessment** — unpatched hosts, misconfig, weak creds, Kerberoasting/
   AS-REP, relay/coercion, LLMNR/NBT-NS. Skill: `detecting-kerberoasting-attacks`.
5. **Exploitation** — PoC only, safe.
6. **Privesc & lateral** — local→domain, lateral within scope. Skills:
   `moving-laterally-with-netexec`, `performing-privilege-escalation-on-linux`.
7. **Report** — attack paths, findings + CVSS + PoC, remediation + detection notes.

## Coverage + evidence
Log each host/service result with `finding-add` (`validated` or `tested-clean`).
Sequential for internal (avoid noisy parallel AD attacks); parallel OK external.
Respect RoE — no DoS, no destructive exploitation, no out-of-scope pivot.
