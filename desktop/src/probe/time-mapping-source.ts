// Public official client inspected on 2026-10-03. The actual page must load
// these exact bytes before the verifier can prefer field 10 over another
// candidate that happens to match the same display minute.
export const CLIENT_TIME_MAPPING_SOURCE = {
  url: 'https://lf3-social.iesdouyin.com/obj/douyin-social-cdn/pcim/static/js/async/__federation_expose_default_export.0ccd0cf4.js',
  sha256: 'a5f00e516582b0e3227edc6e612b6669c71500ad42fcf862780cb36e8e806390',
  buildVersion: '1.0.0.946',
  field: 'field10' as const,
  protocolName: 'create_time',
  displayProperty: 'createdAt',
  sourceOffsets: { messageBodyField10: 677368, convertedCreatedAt: 3875116, dateAdapter: 4715444, rowTimeInput: 324020, timeComponent: 628939, messageInfoGesture: 221909, messageInfoCopy: 322530 },
  messageInfoGesture: { event: 'contextmenu', count: 5, maximumGapMs: 500 }
};

export interface ClientTimeSourceEvidence {
  observedAt: string;
  url: string;
  httpStatus: number;
  sha256: string | null;
  verified: boolean;
  failure: 'http-error' | 'body-too-large' | 'hash-mismatch' | 'body-unreadable' | null;
}

export const CLIENT_MESSAGE_COPY_SOURCE = {
  url: 'https://lf3-social.iesdouyin.com/obj/douyin-social-cdn/pcim/static/js/async/4800.4bb6ba05.js',
  sha256: '0cfc715fc9ac6780b080037e970c8cd3ae4c9c3ff0bb0642e10b2382623d73ac'
};
