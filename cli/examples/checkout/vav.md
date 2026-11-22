# VAV-101 point-to-point checkout
equipment: slot:/Drivers/BacnetNetwork/VAV_101/points

Before starting:

- AHU-1 is running and holding duct static pressure.
- The box's flow sensor has been zeroed.

To check another box, change the number on the `equipment:` line.

## Damper drives closed

- note Airflow
- set DamperPosition 0
- expect Airflow below 60 cfm within 2m

## Damper drives open

- set DamperPosition 100
- expect Airflow above 600 cfm within 2m

## Airflow at each damper position

No pass or fail here: the readings go in the report's notes, for the balancer.

- for 25, 50, 75:
  - set DamperPosition {value}
  - wait 45s
  - note Airflow

## Reheat valve opens

Half open on the damper first, so there is air across the coil.

- set DamperPosition 50
- note ZoneTemp
- set ReheatValve 100
- expect ZoneTemp rises at least 1 °F within 15m

## Reheat valve closes

- set ReheatValve 0
- wait 5m
- note ZoneTemp

## Unoccupied mode takes

- set OccupancyMode unoccupied
- expect OccupancyMode is unoccupied within 30s
