import type { EnvironmentId } from "@t3tools/contracts";

export interface FleetPeer {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
}

/** A saved entry is the user's choice, including entries explicitly switched off. */
export async function bootstrapMissingFleetPeers(input: {
  readonly primaryEnvironmentId: EnvironmentId;
  readonly peers: ReadonlyArray<FleetPeer>;
  readonly hasSavedEnvironment: (id: EnvironmentId) => boolean;
  readonly connect: (peer: FleetPeer) => Promise<void>;
}): Promise<ReadonlyArray<string>> {
  const failed: string[] = [];
  const seen = new Set<EnvironmentId>([input.primaryEnvironmentId]);
  for (const peer of input.peers) {
    if (seen.has(peer.environmentId)) continue;
    seen.add(peer.environmentId);
    if (input.hasSavedEnvironment(peer.environmentId)) continue;
    try {
      const url = new URL(peer.httpBaseUrl);
      if (
        url.protocol !== "https:" ||
        url.pathname !== "/" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        throw new Error("Fleet connection requires a private HTTPS origin.");
      }
      await input.connect(peer);
    } catch {
      // Do not render a provider response or a pairing credential in a toast.
      failed.push(peer.label);
    }
  }
  return failed;
}
