import type { MachineId as MachineIdType } from "@vekrel/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as EnvironmentRegistry from "../connection/registry.ts";
import type * as EnvironmentSupervisor from "../connection/supervisor.ts";

export function runStreamInEnvironment<A, E, R>(
  machineId: MachineIdType,
  stream: Stream.Stream<A, E, R>,
): Stream.Stream<
  A,
  E | EnvironmentRegistry.EnvironmentNotRegisteredError,
  EnvironmentRegistry.EnvironmentRegistry | Exclude<R, EnvironmentSupervisor.EnvironmentSupervisor>
> {
  return Stream.unwrap(
    EnvironmentRegistry.EnvironmentRegistry.pipe(
      Effect.map((registry) => registry.runStream(machineId, stream)),
    ),
  );
}

export function followStreamInEnvironment<A, E, R>(
  machineId: MachineIdType,
  stream: Stream.Stream<A, E, R>,
): Stream.Stream<
  A,
  E,
  EnvironmentRegistry.EnvironmentRegistry | Exclude<R, EnvironmentSupervisor.EnvironmentSupervisor>
> {
  return Stream.unwrap(
    EnvironmentRegistry.EnvironmentRegistry.pipe(
      Effect.map((registry) => registry.followStream(machineId, stream)),
    ),
  );
}
