/** POST /api/users/:id/capacity { capacityHoursPerWeek | null, expectedVersion } */
import { mutateById } from "@/app/api/_lib/route";
import { setCapacity } from "@/server/services/users";

export const POST = mutateById("userId", setCapacity);
