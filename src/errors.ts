export const fail = (message: string): never => {
  throw new Error(message);
};

export const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
