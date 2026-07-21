import type { ApiStatusQuery } from './generated.js';
import { API_STATUS_DOCUMENT } from './operations.js';

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export class ApiGraphQLError extends Error {
  constructor(readonly messages: string[]) {
    super(messages.join('; '));
    this.name = 'ApiGraphQLError';
  }
}

export class ApiTransportError extends Error {
  constructor(cause?: unknown) {
    super('GraphQL API request failed', { cause });
    this.name = 'ApiTransportError';
  }
}

type GraphQLResponse = {
  data?: ApiStatusQuery;
  errors?: Array<{ message?: unknown }>;
};

export const executeApiStatus = async (
  endpoint: string,
  fetchImpl: FetchLike = fetch,
): Promise<ApiStatusQuery['apiStatus']> => {
  let response: Response;

  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: API_STATUS_DOCUMENT }),
    });
  } catch (cause) {
    throw new ApiTransportError(cause);
  }

  if (!response.ok) {
    throw new ApiTransportError(new Error(`HTTP ${response.status}`));
  }

  const payload = (await response.json()) as GraphQLResponse;
  if (payload.errors?.length) {
    throw new ApiGraphQLError(
      payload.errors.map(({ message }) =>
        typeof message === 'string' ? message : 'Unknown GraphQL error',
      ),
    );
  }

  if (!payload.data?.apiStatus) {
    throw new ApiTransportError(new Error('Invalid GraphQL response'));
  }

  return payload.data.apiStatus;
};
