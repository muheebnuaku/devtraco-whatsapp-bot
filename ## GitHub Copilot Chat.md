## GitHub Copilot Chat

- Extension: 0.37.9 (prod)
- VS Code: 1.109.5 (072586267e68ece9a47aa43f8c108e0dcbf44622)
- OS: win32 10.0.19045 x64
- GitHub Account: muheebnuaku

## Network

User Settings:
```json
  "http.systemCertificatesNode": true,
  "github.copilot.advanced.debug.useElectronFetcher": true,
  "github.copilot.advanced.debug.useNodeFetcher": false,
  "github.copilot.advanced.debug.useNodeFetchFetcher": true
```

Connecting to https://api.github.com:
- DNS ipv4 Lookup: 140.82.121.5 (15 ms)
- DNS ipv6 Lookup: Error (132 ms): getaddrinfo ENOTFOUND api.github.com
- Proxy URL: None (4 ms)
- Electron fetch (configured): HTTP 200 (1108 ms)
- Node.js https: HTTP 200 (575 ms)
- Node.js fetch: HTTP 200 (155 ms)

Connecting to https://api.githubcopilot.com/_ping:
- DNS ipv4 Lookup: 140.82.114.22 (48 ms)
- DNS ipv6 Lookup: Error (34 ms): getaddrinfo ENOTFOUND api.githubcopilot.com
- Proxy URL: None (14 ms)
- Electron fetch (configured): HTTP 200 (1794 ms)
- Node.js https: HTTP 200 (962 ms)
- Node.js fetch: HTTP 200 (979 ms)

Connecting to https://copilot-proxy.githubusercontent.com/_ping:
- DNS ipv4 Lookup: 4.225.11.192 (108 ms)
- DNS ipv6 Lookup: Error (144 ms): getaddrinfo ENOTFOUND copilot-proxy.githubusercontent.com
- Proxy URL: None (18 ms)
- Electron fetch (configured): HTTP 200 (625 ms)
- Node.js https: HTTP 200 (646 ms)
- Node.js fetch: HTTP 200 (629 ms)

Connecting to https://mobile.events.data.microsoft.com: HTTP 404 (265 ms)
Connecting to https://dc.services.visualstudio.com: HTTP 404 (1075 ms)
Connecting to https://copilot-telemetry.githubusercontent.com/_ping: HTTP 200 (1389 ms)
Connecting to https://copilot-telemetry.githubusercontent.com/_ping: HTTP 200 (899 ms)
Connecting to https://default.exp-tas.com: HTTP 400 (812 ms)

Number of system certificates: 367

## Documentation

In corporate networks: [Troubleshooting firewall settings for GitHub Copilot](https://docs.github.com/en/copilot/troubleshooting-github-copilot/troubleshooting-firewall-settings-for-github-copilot).