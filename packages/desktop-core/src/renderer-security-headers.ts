export const FRAME_ANCESTORS_POLICY = "frame-ancestors 'none'";

interface HeadersReceivedDetails {
  readonly resourceType: string;
  readonly responseHeaders?: Record<string, string[]>;
}

interface HeadersReceivedResponse {
  readonly responseHeaders?: Record<string, string[]>;
}

interface RendererSecurityHeadersSession {
  readonly webRequest: {
    onHeadersReceived(
      filter: { readonly urls: readonly string[] },
      listener: (
        details: HeadersReceivedDetails,
        callback: (response: HeadersReceivedResponse) => void,
      ) => void,
    ): void;
  };
}

export function installRendererSecurityHeaders(
  electronSession: RendererSecurityHeadersSession,
): void {
  electronSession.webRequest.onHeadersReceived(
    { urls: ['file://*/*'] },
    (details, callback) => {
      const responseHeaders = details.responseHeaders ?? {};
      if (details.resourceType !== 'mainFrame' && details.resourceType !== 'subFrame') {
        callback({ responseHeaders });
        return;
      }

      const contentSecurityPolicyHeader = Object.keys(responseHeaders)
        .find((name) => name.toLowerCase() === 'content-security-policy')
        ?? 'Content-Security-Policy';
      const currentPolicies = responseHeaders[contentSecurityPolicyHeader] ?? [];
      const hasFrameAncestorsNonePolicy = currentPolicies.some((headerValue) => (
        headerValue.split(',').some((policy) => {
          const effectiveDirective = policy
            .split(';')
            .map((directive) => directive.trim().split(/\s+/u))
            .find(([name]) => name?.toLowerCase() === 'frame-ancestors');
          return effectiveDirective?.length === 2
            && effectiveDirective[1]?.toLowerCase() === "'none'";
        })
      ));

      callback({
        responseHeaders: {
          ...responseHeaders,
          [contentSecurityPolicyHeader]: hasFrameAncestorsNonePolicy
            ? currentPolicies
            : [...currentPolicies, FRAME_ANCESTORS_POLICY],
        },
      });
    },
  );
}
