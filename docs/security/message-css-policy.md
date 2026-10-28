# Untrusted message CSS policy

Received HTML, quoted/printed message HTML, and the shared editor sanitizer accept a limited set of inline presentation properties. The browser's native CSSStyleDeclaration parses inline declarations; the application keeps only explicitly listed properties whose grammar does not load resources. Ordinary text/font/color, spacing, borders, dimensions and table formatting remain supported. Unknown properties, vendor/custom properties, positioning, and the pre-existing white-space/min-width exclusions are discarded.

Embedded STYLE elements and arbitrary sender classes are removed; the fixed mail-body structural wrapper class remains. CSS images are unsupported, including background, list, border and mask images, content images, and CSS CID/data images. Legacy HTML background attributes are removed. These resources are discarded rather than restored after Show Images. The AllowStyles checkbox and client setting have been retired; the server continues accepting and returning the historical stored field for old-client compatibility, but it cannot enable message stylesheets.

This intentionally reduces rendering fidelity for messages that depend on embedded stylesheets or CSS backgrounds, including their print/reply/forward representations. The shared Squire setHTML/paste sanitizer also removes CSS images. The separate trusted identity-signature insertion path is unchanged.

Ordinary IMG handling remains the supported image path: received remote sources wait for the existing Block/Ask/whitelist/user decision and use the configured image proxy; known CID and data images retain their existing behavior. Received srcset/sizes remain removed. Editor IMG paste behavior is unchanged.

Node tests exercise the actual application property decision with array-like declarations and source integration contracts. They do not simulate a browser CSS parser. The existing pinned Playwright 1.62.1 fixture includes native CSSOM, actual sanitized DOM and intercepted loopback-only resource cases; it is a formal rendered check only when the exact pinned browser engines are available.
