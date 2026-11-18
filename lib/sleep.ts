/** Async delay — extracted for test mocking */
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
