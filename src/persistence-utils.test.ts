import { fromUint8Array } from "js-base64";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { mergeDsheetContentIntoDocument } from "./persistence-utils";

describe("dSheet content ingress", () => {
  it("preserves Yjs identities when peers recover the same dSheet artifact", () => {
    const recovered = new Y.Doc();
    const sheet = new Y.Map<unknown>();
    sheet.set("id", "tab-1");
    recovered.getArray<Y.Map<unknown>>("active-id").push([sheet]);
    const encoded = fromUint8Array(Y.encodeStateAsUpdate(recovered));

    const peerA = new Y.Doc();
    const peerB = new Y.Doc();
    const resultA = mergeDsheetContentIntoDocument(
      "active-id",
      encoded,
      peerA,
    );
    const resultB = mergeDsheetContentIntoDocument("active-id", encoded, peerB);

    expect(resultA.status).toBe("available");
    expect(resultB.status).toBe("available");
    Y.applyUpdate(peerA, Y.encodeStateAsUpdate(peerB));
    expect(peerA.getArray<Y.Map<unknown>>("active-id").length).toBe(1);
    expect(peerA.getArray<Y.Map<unknown>>("active-id").get(0).get("id")).toBe(
      "tab-1",
    );

    recovered.destroy();
    peerA.destroy();
    peerB.destroy();
  });
});
