/**
 * card-store-cli.ts — thin arg-parsing CLI for the card store public API.
 *
 * All logic lives in card-store-lib-public.ts.
 * This file only: parses argv, reads files/stdin, calls the public API, prints JSON.
 *
 * Commands:
 *   card-store get --store-ref <ref> [--id <card-id>] [--yaml]
 *   card-store set --store-ref <ref> [--ref <jsonfile> | --ref-yaml <yamlfile>] [--yaml]
 *   card-store del --store-ref <ref> --id <card-id> [--id <card-id> ...]
 *   card-store patch --store-ref <ref> --id <card-id> --path <dot.path> [--value-json <json>]
 */
declare function cli(argv: string[]): Promise<void>;

export { cli };
