// Deleted: this step drove the OAuth token flow for /install-github-app and
// depended on saveOAuthTokensIfNeeded (gone with the OAuth line). The 'oauth'
// API-key option was unreachable without isAnthropicAuthEnabled(), so this
// component and its render case were removed from install-github-app.tsx.
