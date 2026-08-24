import assert from "node:assert/strict";
import test from "node:test";
import { parseProviderProbeRouteV1 } from "../server/provider-probe-route.js";
import { INITIAL_SETTINGS_DOCUMENT_V5 } from "../server/settings-v5-default.js";
import {
  providerProbeRouteFromDocument,
  PROVIDER_PROBE_ROUTE_V1_KIND
} from "../shared/provider-probe-route-v1.js";
import { INITIAL_SETTINGS_DOCUMENT_V2 } from "../server/settings-v2-default.js";
import { convertSettingsDocumentV2ToV5 } from "../server/settings-v5-conversion.js";

test("closed probe routes reject writing, routing maps, and extra records", () => {
  const document = INITIAL_SETTINGS_DOCUMENT_V5;
  const profile = document.profiles.default!;
  const model = document.models[profile.modelId]!;
  const connection = document.connections[model.connectionId]!;
  const parsed = parseProviderProbeRouteV1({
    kind: PROVIDER_PROBE_ROUTE_V1_KIND,
    connection,
    model,
    profile
  });
  assert.equal(parsed.kind, PROVIDER_PROBE_ROUTE_V1_KIND);
  assert.equal(parsed.profile.generationReasoning.kind, "independent");
  assert.throws(
    () => parseProviderProbeRouteV1({
      kind: PROVIDER_PROBE_ROUTE_V1_KIND,
      connection,
      model,
      profile,
      writing: document.writing
    }),
    /unknown key/u
  );
  assert.throws(
    () => parseProviderProbeRouteV1({
      kind: "settings-document",
      connection,
      model,
      profile
    }),
    /kind/u
  );
});

test("schema-2 documents project to a closed probe route without writing", () => {
  const route = providerProbeRouteFromDocument(INITIAL_SETTINGS_DOCUMENT_V2);
  assert.equal(route.kind, PROVIDER_PROBE_ROUTE_V1_KIND);
  assert.deepEqual(route.profile.generationReasoning, { kind: "legacy", effort: "default" });
  const converted = convertSettingsDocumentV2ToV5(INITIAL_SETTINGS_DOCUMENT_V2);
  assert.equal(converted.writing.defaultAuthorBrief, INITIAL_SETTINGS_DOCUMENT_V2.writing.defaultAuthorBrief);
  assert.ok(!("writing" in route));
  assert.ok(!("routing" in route));
});
