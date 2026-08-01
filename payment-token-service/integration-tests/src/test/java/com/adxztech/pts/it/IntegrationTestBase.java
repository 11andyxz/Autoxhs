package com.adxztech.pts.it;

import org.junit.jupiter.api.BeforeAll;

/**
 * Shared entry point: boots the stack once per test JVM.
 *
 * <p>The fixture is a process-wide singleton because starting eight Spring contexts, a Hazelcast member
 * and four Hazelcast clients per test class would dominate the suite's runtime. Tests stay independent by
 * owning their own tokens and funding cards ({@link ItCards}) rather than by getting a fresh stack.
 */
abstract class IntegrationTestBase {

    protected static StackFixture fixture;
    protected static StackClient client;

    @BeforeAll
    static void bootStack() {
        fixture = StackFixture.get();
        client = new StackClient(fixture);
    }
}
