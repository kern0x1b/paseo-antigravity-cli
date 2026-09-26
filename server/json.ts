/** Any value JSON can hold. */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
