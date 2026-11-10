/** Capture and correlation are independent: lost correlation never discards observed bytes. */
export type WebSocketCaptureReason =
  | 'correlation_lost'
  | 'cancel_observed'
  | 'body_limit'
  | 'buffer_limit'
  | 'frame_parse_failure'
  | 'connection_closed'
  | 'save_failed';

export interface WebSocketObservation {
  connectionId: string;
  sequence: number;
  observedAt: number;
  host: string;
  port: number;
  path: string;
  direction: 'client' | 'server' | 'recorder';
  kind: 'open' | 'message' | 'diagnostic' | 'close';
  state: 'ready' | 'cancelling' | 'lost' | 'closed';
  reason?: WebSocketCaptureReason;
  detail?: string;
  /** First ambiguous observation on this connection. Never reset by a later success. */
  lostAt?: number;
  recovery?: 'new_connection' | 'cancel_terminal';
  bytes: number;
  payload?: string;
  representation?: 'text' | 'binary' | 'wire';
  omission?: 'body_limit' | 'buffer_limit';
  omittedObservations?: number;
  throughSequence?: number;
}
