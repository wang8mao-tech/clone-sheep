import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { profileApi, profileKeys } from "./model-profiles.js";
import { pickProfile, type ProfileNeed } from "./profile-choice.js";

/**
 * CMP-010 的数据与选中项：拉档案列表；没动过就用默认（想要的 → 默认档案 → 第一个能选的），动过就用人选的。
 * 人选的那个后来变得不能选了（被删、被改成不看图），退回默认
 */
export function useProfileChoice(need: ProfileNeed, preferred?: string | null) {
  const profiles = useQuery({ queryKey: profileKeys.list, queryFn: () => profileApi.list() });
  const [choice, setChoice] = useState<string | null>(null);
  const list = profiles.data?.profiles;
  const profileId = list ? (pickProfile(list, need, choice ?? preferred) ?? null) : null;
  return {
    profiles: list,
    profileId,
    setProfileId: setChoice,
    error: profiles.error,
    retry: () => void profiles.refetch(),
    retrying: profiles.isFetching,
  };
}
