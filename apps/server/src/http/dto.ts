/** DTO for the connectors the UI renders. */
import { ConnectorRuntime } from '../connectors/service.js';

export interface ConnectorDto {
  id: string;
  name: string;
  emoji: string;
  tagline: string;
  brandColor: string;
  mcpUrl: string;
  status: {
    state: string;
    error?: string;
    toolsCount?: number;
    lastCheckedAt?: string;
    connectedAt?: string;
  };
  redirectUri: string;
  pasteFallback: boolean;
  callout: string;
}

export function toDto(r: ConnectorRuntime, pasteFallback: boolean): ConnectorDto {
  return {
    id: r.def.id,
    name: r.def.name,
    emoji: r.def.emoji,
    tagline: r.def.tagline,
    brandColor: r.def.brandColor,
    mcpUrl: r.def.mcpUrl,
    status: r.snapshot(),
    redirectUri: r.def.redirectUri,
    pasteFallback,
    callout: r.def.realMoneyWarning,
  };
}
