import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { API_KEY_ONLY_NOTE, PROFILE_PRESETS } from "../agent/profile-presets.js";
import { probeProfile, type ProbeResult } from "../agent/profile-test.js";
import {
  createProfile,
  deleteProfile,
  findProfile,
  listProfiles,
  markVerified,
  presentProfile,
  ProfileError,
  requireProfile,
  setDefaultProfile,
  updateProfile,
  type ProfileRow,
} from "../agent/profiles.js";
import { archiveErrorHandler } from "./errors.js";

/** 形状在这里判，内容规则（长度、重名、地址、单价）在 profiles.ts 判，错误码一致地回给界面 */
const Price = z.number().nullish();
const Create = z.object({
  name: z.string(),
  kind: z.enum(["subscription", "anthropic", "compatible"]),
  baseUrl: z.string().nullish(),
  token: z.string().optional(),
  modelId: z.string(),
  fastModelId: z.string().nullish(),
  supportsVision: z.boolean(),
  supportsWebSearch: z.boolean(),
  priceIn: Price,
  priceOut: Price,
});
const Patch = Create.omit({ kind: true }).partial();

function profileErrorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply): void {
  if (error instanceof ProfileError) {
    void reply.status(error.status).send({ error: { code: error.code, message: error.message } });
    return;
  }
  archiveErrorHandler(error, request, reply);
}

/**
 * 测试连接的并发去重：同一档案、同一版配置点两下只跑一次。键带上 updated_at：改过之后再点是另一版配置，
 * 不能搭上旧配置那次的车（10.1 审查 M1）
 */
const probing = new Map<string, Promise<ProbeResult>>();

export interface ModelProfileRouteOptions {
  /** 测试替身：不打真实上游 */
  probe?: (row: ProfileRow) => Promise<ProbeResult>;
}

/** 模型档案（REQ-010、SCREEN-009「Agent 模型」）：列表、预设、增删改、设为默认、测试连接 */
export async function modelProfileRoutes(app: FastifyInstance, options: ModelProfileRouteOptions = {}): Promise<void> {
  app.setErrorHandler(profileErrorHandler);
  const probe = options.probe ?? probeProfile;

  app.get("/api/model-profiles", async () => ({ profiles: listProfiles().map(presentProfile) }));

  app.get("/api/model-profiles/presets", async () => ({ presets: PROFILE_PRESETS, note: API_KEY_ONLY_NOTE }));

  app.post("/api/model-profiles", async (request, reply) => {
    const body = Create.parse(request.body);
    return reply.status(201).send({ profile: presentProfile(createProfile(body)) });
  });

  app.patch("/api/model-profiles/:id", async (request) => {
    const { id } = request.params as { id: string };
    return { profile: presentProfile(updateProfile(id, Patch.parse(request.body ?? {}))) };
  });

  app.delete("/api/model-profiles/:id", async (request) => {
    const { id } = request.params as { id: string };
    deleteProfile(id);
    return { ok: true };
  });

  app.post("/api/model-profiles/:id/default", async (request) => {
    const { id } = request.params as { id: string };
    return { profile: presentProfile(setDefaultProfile(id)) };
  });

  app.post("/api/model-profiles/:id/test", async (request) => {
    const { id } = request.params as { id: string };
    const row = requireProfile(id);
    const key = `${id}@${row.updated_at ?? ""}`;
    let pending = probing.get(key);
    if (!pending) {
      pending = probe(row).finally(() => probing.delete(key));
      probing.set(key, pending);
    }
    const result = await pending;
    // 测试途中档案被删了、或被改过（测的是旧配置）：结论不落到现在的档案上
    const after = findProfile(id);
    const current = after && after.updated_at === row.updated_at;
    const saved = current ? markVerified(id, result.ok ? new Date().toISOString() : null) : after;
    return { result, stale: !current, ...(saved ? { profile: presentProfile(saved) } : {}) };
  });
}
