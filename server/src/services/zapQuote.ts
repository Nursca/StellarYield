import * as StellarSdk from "@stellar/stellar-sdk";
import crypto from "crypto";
import { slippageRegistry } from "./slippageRegistry";
import { getYieldData } from "./yieldService";
import { freezeService } from "./freezeService";
import { getZapSupportedAssetsPayload } from "../config/zapAssetsConfig";
import { recordFailure, resolveNetworkLabel } from "../monitoring/prometheus";

export interface ZapQuoteBody {
  inputTokenContract: string;
  vaultTokenContract: string;
  amountInStroops: string;
  inputDecimals: number;
  vaultDecimals: number;
  slippageTolerance?: number;
  protocol?: string;
}

/**
 * Server-side time-to-live for a zap quote preview, in milliseconds. This is the
 * source of truth for `expiresAt` on `POST /api/zap/quote` and must be kept in
 * sync with the client preview guard (`client/src/features/zap/quoteFreshness.ts`
 * `ZAP_QUOTE_TTL_MS`). Both sides reject a quote whose `expiresAt` has passed.
 */
export const ZAP_QUOTE_EXPIRY_MS = parseQuoteExpiryMs(process.env.ZAP_QUOTE_TTL_MS);

/** Parses the `ZAP_QUOTE_TTL_MS` env value; falls back to 60 000 ms when invalid. */
export function parseQuoteExpiryMs(raw?: string): number {
  const n = Number.parseInt(raw ?? "60000", 10);
  return Number.isSafeInteger(n) && n > 0 ? n : 60_000;
}

/** Minimal shape of a quote used by the expiry check. */
export interface ZapQuoteExpiryInput {
  expiresAt?: string;
}

/**
 * Pure, deterministic quote-expiry predicate.
 *
 * A quote is expired when:
 *  - it has no `expiresAt` (cannot be proven fresh), or
 *  - `expiresAt` is not a parseable timestamp, or
 *  - `expiresAt` is in the past relative to `nowMs`.
 *
 * The boundary is exclusive: a quote whose `expiresAt` equals `nowMs` is
 * still valid. This mirrors the client preview guard so the two sides agree on
 * the exact instant a quote becomes invalid without parsing provider errors.
 */
export function isQuoteExpired(
  quote: ZapQuoteExpiryInput,
  nowMs: number = Date.now(),
): boolean {
  if (!quote.expiresAt || typeof quote.expiresAt !== "string") {
    return true;
  }
  const expiresMs = new Date(quote.expiresAt).getTime();
  if (!Number.isFinite(expiresMs)) {
    return true;
  }
  return nowMs > expiresMs;
}

export interface ZapQuoteResult {
  path: { contractId: string; label?: string }[];
  expectedAmountOutStroops: string;
  source: "router_simulation" | "fallback_rate";
  slippageApplied: number;
  amountOutAfterSlippage: string;
  quotedAt: string;
  minAmountOutStroops: string;
  quoteAgeMs: number;
  isFallback: boolean;
  issuedAt: string;
  expiresAt: string;
  routeHash: string;
  assetConfigVersion: string;
}

const rpcUrl = process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";

function mulDivStroops(amountIn: string, numerator: string, denominator: string): string {
  const a = BigInt(amountIn);
  const n = BigInt(numerator);
  const d = BigInt(denominator);
  if (d === BigInt(0)) {
    return "0";
  }
  return ((a * n) / d).toString();
}

export function getAssetConfigVersion(): string {
  const payload = getZapSupportedAssetsPayload();
  const data = JSON.stringify(payload);
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function computeRouteHash(path: { contractId: string }[]): string {
  const ids = path.map(p => p.contractId).join("->");
  return crypto.createHash("sha256").update(ids).digest("hex");
}

export async function quoteViaRouterSimulation(
  body: ZapQuoteBody,
): Promise<Omit<ZapQuoteResult, "issuedAt" | "expiresAt" | "routeHash" | "assetConfigVersion"> | null> {
  const routerId = process.env.DEX_ROUTER_CONTRACT_ID;
  const simSource = process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
  if (!routerId || !simSource) {
    return null;
  }

  try {
    const server = new StellarSdk.rpc.Server(rpcUrl);
    const router = new StellarSdk.Contract(routerId);
    const amountIn = BigInt(body.amountInStroops);
    const minOut = BigInt(0);

    const op = router.call(
      "swap",
      new StellarSdk.Address(body.inputTokenContract).toScVal(),
      new StellarSdk.Address(body.vaultTokenContract).toScVal(),
      StellarSdk.nativeToScVal(amountIn, { type: "i128" }),
      StellarSdk.nativeToScVal(minOut, { type: "i128" }),
    );

    const source = await server.getAccount(simSource);
    const tx = new StellarSdk.TransactionBuilder(source, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase:
        process.env.NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015",
    })
      .addOperation(op)
      .setTimeout(30)
      .build();

    const timeoutMs = parseInt(process.env.SOROBAN_RPC_TIMEOUT_MS ?? "10000", 10);
    const simulated = await Promise.race([
      server.simulateTransaction(tx),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout")), timeoutMs)
      ),
    ]);

    if (StellarSdk.rpc.Api.isSimulationError(simulated)) {
      return null;
    }

    const success = simulated as StellarSdk.rpc.Api.SimulateTransactionSuccessResponse;
    const retval = success.result?.retval;
    if (!retval) {
      return null;
    }

    const out = StellarSdk.scValToNative(retval) as bigint | number | string;
    const expected =
      typeof out === "bigint" ? out : BigInt(String(out));

    const now = Date.now();

    return {
      path: [
        { contractId: body.inputTokenContract, label: "in" },
        { contractId: body.vaultTokenContract, label: "out" },
      ],
      expectedAmountOutStroops: expected.toString(),
      source: "router_simulation",
      slippageApplied: 0,
      amountOutAfterSlippage: expected.toString(),
      quotedAt: new Date(now).toISOString(),
      minAmountOutStroops: expected.toString(),
      quoteAgeMs: 0,
      isFallback: false,
    };
  } catch {
    recordFailure({
      provider: body.protocol || "default",
      network: resolveNetworkLabel(),
      route: "zap/quote",
      failure_category: "router_simulation_failed",
    });
    return null;
  }
}

export function quoteFallback(body: ZapQuoteBody): Omit<ZapQuoteResult, "issuedAt" | "expiresAt" | "routeHash" | "assetConfigVersion"> {
  const amountIn = body.amountInStroops;
  const now = Date.now();

  if (body.inputTokenContract === body.vaultTokenContract) {
    return {
      path: [{ contractId: body.inputTokenContract }],
      expectedAmountOutStroops: amountIn,
      source: "fallback_rate",
      slippageApplied: 0,
      amountOutAfterSlippage: amountIn,
      quotedAt: new Date(now).toISOString(),
      minAmountOutStroops: amountIn,
      quoteAgeMs: 0,
      isFallback: true,
    };
  }

  const num = process.env.ZAP_FALLBACK_NUMERATOR ?? "1";
  const den = process.env.ZAP_FALLBACK_DENOMINATOR ?? "1";
  const expected = mulDivStroops(amountIn, num, den);

  return {
    path: [
      { contractId: body.inputTokenContract, label: "in" },
      { contractId: body.vaultTokenContract, label: "out" },
    ],
    expectedAmountOutStroops: expected,
    source: "fallback_rate",
    slippageApplied: 0,
    amountOutAfterSlippage: expected,
    quotedAt: new Date(now).toISOString(),
    minAmountOutStroops: expected,
    quoteAgeMs: 0,
    isFallback: true,
  };
}

export async function getZapQuote(body: ZapQuoteBody): Promise<ZapQuoteResult> {
  if (freezeService.isFrozen(body.protocol)) {
    recordFailure({
      provider: body.protocol || "default",
      network: resolveNetworkLabel(),
      route: "zap/quote",
      failure_category: "frozen",
    });
    throw new Error(`Quoting is temporarily disabled for ${body.protocol || "all protocols"} due to safety freeze.`);
  }

  const quotedAt = new Date().toISOString();

  const sim = (await quoteViaRouterSimulation(body)) || quoteFallback(body);

  const protocol = body.protocol || "default";
  const model = slippageRegistry.getModel(protocol);

  const yieldData = await getYieldData();
  const protocolData = yieldData.find(y => y.protocolName.toLowerCase() === protocol.toLowerCase());
  const tvl = BigInt(Math.floor(protocolData?.tvl || 10_000_000));

  const amountIn = BigInt(body.amountInStroops);
  const slippage = model.calculateSlippage(amountIn, tvl);

  const userSlippage = body.slippageTolerance !== undefined
    ? Math.min(Math.max(body.slippageTolerance, 0.001), 0.15)
    : slippage;

  const effectiveSlippage = Math.max(slippage, userSlippage);

  const expectedOut = BigInt(sim.expectedAmountOutStroops);
  const multiplier = 1 - effectiveSlippage;
  const outAfterSlippage = (expectedOut * BigInt(Math.floor(multiplier * 10000))) / BigInt(10000);

  const now = Date.now();
  const quotedAtMs = new Date(quotedAt).getTime();

  const routeHash = computeRouteHash(sim.path);
  const assetConfigVersion = getAssetConfigVersion();
  const issuedAt = quotedAt;
  const expiresAt = new Date(quotedAtMs + ZAP_QUOTE_EXPIRY_MS).toISOString();

  return {
    ...sim,
    slippageApplied: effectiveSlippage,
    amountOutAfterSlippage: outAfterSlippage.toString(),
    minAmountOutStroops: outAfterSlippage.toString(),
    quotedAt,
    quoteAgeMs: now - quotedAtMs,
    isFallback: sim.source === "fallback_rate",
    issuedAt,
    expiresAt,
    routeHash,
    assetConfigVersion,
  };
}

/**
 * Machine-readable rejection codes returned by {@link verifyZapQuote}.
 * The set is closed so clients can map failures to deterministic UI states
 * without parsing provider message strings.
 */
export type ZapQuoteVerificationErrorCode =
  | "INVALID_QUOTE"
  | "STALE_QUOTE"
  | "CONFIG_DRIFT"
  | "ROUTE_MISMATCH"
  | "UNSUPPORTED_ASSET"
  | "SLIPPAGE_EXCEEDED";

/** Result of verifying a previously issued zap quote. */
export type ZapQuoteVerification =
  | { valid: true }
  | { valid: false; reason: string; errorCode: ZapQuoteVerificationErrorCode };

/**
 * Codes a client can recover from by requesting a fresh quote (as opposed to
 * changing inputs or an unrecoverable internal failure).
 */
export const RECOVERABLE_VERIFY_ERROR_CODES: ReadonlySet<ZapQuoteVerificationErrorCode> =
  new Set<ZapQuoteVerificationErrorCode>([
    "STALE_QUOTE",
    "CONFIG_DRIFT",
    "ROUTE_MISMATCH",
    "UNSUPPORTED_ASSET",
  ]);

export function verifyZapQuote(quote: unknown): ZapQuoteVerification {
  if (!quote || typeof quote !== "object") {
    return { valid: false, reason: "Invalid quote format", errorCode: "INVALID_QUOTE" };
  }
  const q = quote as Record<string, unknown>;
  if (isQuoteExpired(q as ZapQuoteExpiryInput)) {
    return { valid: false, reason: "Quote has expired", errorCode: "STALE_QUOTE" };
  }
  const currentVersion = getAssetConfigVersion();
  if (q.assetConfigVersion !== currentVersion) {
    return { valid: false, reason: "Asset configuration has drifted", errorCode: "CONFIG_DRIFT" };
  }
  if (!q.path || !Array.isArray(q.path)) {
    return { valid: false, reason: "Invalid path in quote", errorCode: "ROUTE_MISMATCH" };
  }
  const path = q.path as { contractId: string }[];
  const currentRouteHash = computeRouteHash(path);
  if (q.routeHash !== currentRouteHash) {
    return { valid: false, reason: "Route path mismatch", errorCode: "ROUTE_MISMATCH" };
  }
  // Check unsupported asset transitions
  const payload = getZapSupportedAssetsPayload();
  const supportedIds = new Set([
    ...payload.assets.map(a => a.contractId),
    payload.vaultToken.contractId
  ]);
  for (const hop of path) {
    if (!supportedIds.has(hop.contractId)) {
      return { valid: false, reason: `Asset ${hop.contractId} is no longer supported`, errorCode: "UNSUPPORTED_ASSET" };
    }
  }
  // Check slippage exceeded — reject quotes where applied slippage exceeds maximum threshold
  if (typeof q.slippageApplied === "number" && q.slippageApplied > 0.15) {
    return { valid: false, reason: `Slippage ${(q.slippageApplied * 100).toFixed(2)}% exceeds maximum allowed threshold of 15%`, errorCode: "SLIPPAGE_EXCEEDED" };
  }
  return { valid: true };
}
