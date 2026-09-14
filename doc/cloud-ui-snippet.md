# Cloud UI snippet

Cloud operators can set `PAPERCLIP_CLOUD_UI_SNIPPET` to an HTML snippet.
The server inserts it before `</body>` in static and Vite-served UI pages.
It requires the existing Cloud-managed instance signal. Self-hosted instances
ignore this setting. No snippet is enabled by default.

This is trusted deployment configuration, not user input. It executes in the
application origin and is visible to every browser that receives the UI shell.
Do not include secrets or customer data. Restart the app after changing it.
Operators must review scripts and any required CSP changes before deployment.

## Base64 variant

Delivery pipelines that write env vars through provider APIs can sit behind
web application firewalls that reject values containing raw script markup.
`PAPERCLIP_CLOUD_UI_SNIPPET_B64` carries the same snippet through them as
standard base64 of the UTF-8 HTML:

```sh
PAPERCLIP_CLOUD_UI_SNIPPET_B64="$(base64 < snippet.html)"
```

Whitespace and line wrapping in the value are tolerated. A value that is not
canonical padded base64 of UTF-8 text, or that decodes to blank, is ignored —
if the widget does not appear, check that the value round-trips through
`base64 -d`. A present `PAPERCLIP_CLOUD_UI_SNIPPET` always wins, blank
included: clearing the plain variable to blank disables injection even while
a base64 value is still deployed. Everything else about the snippet is
unchanged.

## Plain closed beta

Set the value to this standard embed, replacing `YOUR_CHAT_APP_ID` with the
public chat app ID for the target environment:

```html
<script>
(function(d) {
  var script = d.createElement('script');
  script.src = 'https://chat.cdn-plain.com/index.js';
  script.onload = function() { Plain.init({ appId: 'YOUR_CHAT_APP_ID' }); };
  d.head.appendChild(script);
})(document);
</script>
```

No signing secret or Plain API key is required. No Paperclip customer identity
or organization data is passed. Plain manages the anonymous browser session;
there is no Paperclip account-switch integration. Ask users for identifying
information when needed. The existing feedback flag remains unchanged.

Docs: [Plain chat](https://www.plain.com/docs/product/channels/chat).

## Verification and rollback

On staging, open `/`, `/index.html`, and an organization dashboard directly.
Confirm the bubble appears and a test message reaches Plain. Verify the support
reply returns. On a self-hosted instance, confirm no snippet or widget is loaded.
Unset the snippet and restart to remove it on the next page load. Existing open
tabs retain the widget until refreshed. No production deployment is implied.

## Embedded feedback panel (opt-in)

Set `PAPERCLIP_CLOUD_FEEDBACK_APP_ID` to the target environment's public
`liveChatApp_...` ID and restart the instance. This works only on Cloud-managed
instances. The server emits public JSON configuration. Product code loads Plain
on the first click of **Share feedback** and embeds it in a persistent panel.

While this value is nonblank, it takes precedence over both legacy snippet
variables. The old snippet is not injected, so it cannot create a second widget.
An invalid ID disables both modes rather than falling back to an old initializer.
No signing secrets, account identity, task content, page URLs, or logs are added
to the configuration. Plain remains an anonymous browser session, as in the
standard embed above. It is not isolated by Paperclip account; use separate
browser profiles on shared devices. Authenticated customer context is separate
work and is not provided by this UI change.

The panel uses `embedAt`, `hideLauncher`, `entryPoint`, `theme`, and `style.brandColor`.
It retains Plain's default copy, input styles, attachments, and conversations.
Theme changes use `Plain.update` without replacing the host. Loading and SDK
failures retain the email support link. A failed session requires a page reload.
Sign-out hides the chat before the Cloud logout navigation. Account changes
within the document invalidate the host instead of reusing it for another user.
No private widget classes or shadow-root styles are modified.

Verify the setting on staging before production: one script and no floating
launcher; collapsed/mobile sidebar access; keyboard and Escape; light/dark;
close/reopen and route changes preserve drafts; blocked CDN exposes email fallback;
message reaches Plain/Slack and a human reply returns and survives reload.
The local Cloud simulation proves UI behavior only, not production deployment.

To roll back, clear `PAPERCLIP_CLOUD_FEEDBACK_APP_ID`, restore the previous
standard snippet if needed, restart, and refresh existing tabs. No message data
is migrated or deleted. Existing tabs keep their old code until refreshed.
