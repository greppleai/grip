// Inline the Grepple logo so callback pages work without an asset server or network access.
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 33.866666 33.866666" width="100%" height="100%" aria-hidden="true">
  <rect fill="#03815e" width="4.130908" height="8.197772" x="4.4576864" y="-29.642889" transform="rotate(135)" />
  <rect fill="#03815e" width="3.2359862" height="6.4218025" x="31.978354" y="-2.8312788" transform="rotate(45)" />
  <rect fill="#03815e" width="4.3664689" height="8.6652403" x="15.093356" y="-7.0035233" transform="matrix(0.70457045,0.70963404,-0.70457045,0.70963404,0,0)" />
  <rect fill="#04bd88" width="11.690248" height="12.840108" x="2.2676623" y="10.447897" rx="2.3883214" ry="2.3883214" />
  <rect fill="#04bd88" width="10.076248" height="10.076248" x="14.357004" y="23.349915" rx="2.4876626" ry="2.4876626" />
  <rect fill="#04bd88" width="7.9374213" height="7.9374213" x="23.661583" y="16.054033" rx="2.4779725" ry="2.4779725" />
  <rect fill="#04bd88" width="9.987009" height="9.8861303" x="14.200699" y="0.44050309" rx="2.4407253" ry="2.4407253" />
</svg>`;

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

interface OAuthPageOptions {
	title: string;
	heading: string;
	message: string;
	details?: string;
}

function renderPage(options: OAuthPageOptions): string {
	const title = escapeHtml(options.title);
	const heading = escapeHtml(options.heading);
	const message = escapeHtml(options.message);
	const details = options.details ? escapeHtml(options.details) : undefined;

	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    :root {
      --text: #fafafa;
      --text-dim: #a1a1aa;
      --page-bg: #09090b;
      --font-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    }
    * { box-sizing: border-box; }
    html { color-scheme: dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: var(--page-bg);
      color: var(--text);
      font-family: var(--font-sans);
      text-align: center;
    }
    main {
      width: 100%;
      max-width: 560px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }
    .logo {
      width: 72px;
      height: 72px;
      display: block;
      margin-bottom: 24px;
    }
    h1 {
      margin: 0 0 10px;
      font-size: 28px;
      line-height: 1.15;
      font-weight: 650;
      color: var(--text);
    }
    p {
      margin: 0;
      line-height: 1.7;
      color: var(--text-dim);
      font-size: 15px;
    }
    .details {
      margin-top: 16px;
      font-family: var(--font-mono);
      font-size: 13px;
      color: var(--text-dim);
      white-space: pre-wrap;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <main>
    <div class="logo">${LOGO_SVG}</div>
    <h1>${heading}</h1>
    <p>${message}</p>
    ${details ? `<div class="details">${details}</div>` : ""}
  </main>
</body>
</html>`;
}

export function oauthSuccessHtml(message: string): string {
	return renderPage({
		title: "Authentication successful",
		heading: "Authentication successful",
		message,
	});
}

export function oauthErrorHtml(message: string, details?: string): string {
	return renderPage({
		title: "Authentication failed",
		heading: "Authentication failed",
		message,
		details,
	});
}
