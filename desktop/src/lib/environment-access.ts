/** HAC-166: renderer copy for admitting this Mac's network to an aws-cpu environment. */
export type EnvironmentAccessState = "pending";

export const ENVIRONMENT_ACCESS_PENDING = "Allowing this Mac's network to reach the environment…";

export function environmentAccessLabel(state: EnvironmentAccessState): string {
  switch (state) {
    case "pending":
      return ENVIRONMENT_ACCESS_PENDING;
  }
}
