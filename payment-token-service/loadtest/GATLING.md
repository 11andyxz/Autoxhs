# Gatling simulation

`src/gatling/java/PaymentTokenSimulation.java` is the Gatling equivalent of the driver in
`src/main/java`. It is **shipped as reviewable source and is not part of the build**: the Gatling
Maven plugin pulls a Scala toolchain well over 100 MB, which would have made the build heavy and,
on the machine this was written on, unverifiable. See `docs/DESIGN_DEVIATIONS.md` §5.

To run it, add the plugin and dependency:

```xml
<dependency>
  <groupId>io.gatling.highcharts</groupId>
  <artifactId>gatling-charts-highcharts</artifactId>
  <version>3.11.5</version>
  <scope>test</scope>
</dependency>
<plugin>
  <groupId>io.gatling</groupId>
  <artifactId>gatling-maven-plugin</artifactId>
  <version>4.9.6</version>
</plugin>
```

then move the source under `src/test/java` and:

```bash
mvn gatling:test -Dgatling.simulationClass=com.adxztech.pts.loadtest.gatling.PaymentTokenSimulation
```

## What the two harnesses share

The methodology, which is what the latency claim actually rests on:

- **An open workload model.** Arrival rate, not looping virtual users. A closed model throttles
  itself when the system slows — fewer requests offered, so measured latency *improves* as the
  system degrades. That is coordinated omission, and it is how load tests come to report a healthy
  p99 for a failing service.
- **A Zipfian token feeder.** Card usage is heavily skewed. A uniform feeder would make a
  near-cache of any realistic size miss most of the time, understating the optimization and
  misrepresenting what the cache is for.
- **Latency measured from scheduled arrival.** The JDK driver records from the moment a request was
  *due*, so queueing delay is included. `LoadHarnessTest.Driver.noCoordinatedOmission` asserts it.

The JDK driver additionally refuses to report an arm whose accept rate falls below 95%, because an
arm that mostly rejects has measured a short-circuited path. That guard exists because the first
version of the A/B was wrong in exactly that way — see `docs/RESULTS.md` §2.
