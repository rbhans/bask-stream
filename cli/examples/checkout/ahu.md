# AHU-OR functional test
station: Riverside
equipment: slot:/Drivers/BacnetNetwork/AHU_OR/points

The operating room air handler. Before starting:

- The drive is in Auto and the disconnect is closed.
- Both operating rooms are empty, and the charge nurse knows the air will stop for a minute.

## Supply fan stops and proves off

The status is a current switch on the fan motor. If this step fails with the fan
plainly stopped, the switch is set too low or its input is jumpered.

- note SupplyFanSpeed
- set SupplyFanSpeed 0
- expect SupplyFanStatus is off within 30s

## Supply fan starts and proves on

- set SupplyFanSpeed 50 %
- expect SupplyFanStatus is on within 30s

## Supply air follows its setpoint

Two setpoints, so that a reading that only happens to be right at one of them does not pass.

- note SupplyAirTemp
- for 64, 66:
  - set SupplyAirSetpoint {value}
  - expect SupplyAirTemp within 1 of {value} within 5m

## Left as found

Nothing is commanded here. Each step above released what it overrode when it ended,
so the unit should be back under its own control.

- expect SupplyFanStatus is on within 1m
- expect SupplyAirTemp within 3 of 62 within 5m
