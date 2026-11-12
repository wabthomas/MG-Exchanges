import type { KycDocumentContentType } from '@mgx/contracts';

const SIGNATURES: readonly {
  readonly type: KycDocumentContentType;
  readonly bytes: readonly number[];
}[] = [
  { type: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { type: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  // « %PDF- »
  { type: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
];

/**
 * Type réel d'un fichier, lu sur ses premiers octets, ou `null` si ce n'est aucun des formats
 * acceptés. Le type annoncé par le client n'est jamais cru sur parole : c'est celui-ci qui
 * est enregistré, puis resservi tel quel au back-office.
 */
export function detectContentType(content: Uint8Array): KycDocumentContentType | null {
  const match = SIGNATURES.find(
    ({ bytes }) =>
      content.length >= bytes.length && bytes.every((byte, index) => content[index] === byte),
  );
  return match?.type ?? null;
}

const EXTENSIONS: Readonly<Record<KycDocumentContentType, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'application/pdf': 'pdf',
};

export function fileExtensionOf(type: KycDocumentContentType): string {
  return EXTENSIONS[type];
}
