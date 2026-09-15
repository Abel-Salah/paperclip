import { useQuery } from "@tanstack/react-query";
import { instanceSettingsApi } from "../api/instanceSettings";
import { queryKeys } from "../lib/queryKeys";

export function useLiveServicesEnabled() {
  const { data, isFetched, isError } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
    refetchInterval: 10_000,
  });
  return { enabled: !isError && data?.enableLiveServices === true, loaded: isFetched };
}
