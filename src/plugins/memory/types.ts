export interface MemoryCredentials {
  /** The Graphiti REST server (getzep/graphiti `server/`), such as https://graphiti.example.com. Never hardcoded: one per profile. */
  baseUrl: string;
  /** Sent as `Authorization: Bearer <token>` to the proxy in front of the server. */
  token: string;
  /** The group (namespace) used when a command is given no `--group`. */
  defaultGroup?: string;
}

/** Where a fact came from, parsed from an episode's `source_description` (see `formatSource`). */
export interface MemorySource {
  ref: string | null;
  url: string | null;
}

/** `FactResult` in graph_service/dto/retrieve.py: one edge of the graph, as a sentence. */
export interface GraphitiFact {
  uuid: string;
  name: string;
  fact: string;
  valid_at: string | null;
  invalid_at: string | null;
  created_at: string;
  expired_at: string | null;
  source_node_uuid: string;
  target_node_uuid: string;
  /** Uuids of the episodes the fact was extracted from. */
  episodes: string[];
}

/** An `EpisodicNode` (graphiti_core/nodes.py), as `GET /episodes/{group_id}` returns it. */
export interface GraphitiEpisode {
  uuid: string;
  name: string;
  group_id: string;
  labels?: string[];
  created_at: string;
  source?: string;
  source_description: string;
  content: string;
  valid_at: string | null;
  entity_edges?: string[];
}

/** A fact with the documents it traces back to. */
export interface MemoryFact extends GraphitiFact {
  sources: Array<MemorySource & { episode: string }>;
}

/** An episode with its ref and url read back from `source_description`. */
export interface MemoryEpisode extends MemorySource {
  uuid: string;
  name: string;
  group: string;
  text: string;
  created_at: string;
  valid_at: string | null;
  source_description: string;
}

export interface MemoryAddInput {
  group: string;
  ref: string;
  url?: string;
  text: string;
  name?: string;
  /** When the fact was true or the document was written, ISO 8601; the server's now when absent. */
  time?: string;
}

/** What `add` queued: the server answers 202 and extracts facts later, so this is all there is to show. */
export interface MemoryAdded extends MemorySource {
  uuid: string;
  name: string;
  group: string;
  source_description: string;
  queued: true;
}
