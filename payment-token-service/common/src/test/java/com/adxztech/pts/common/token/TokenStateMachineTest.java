package com.adxztech.pts.common.token;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Exhaustive coverage of the transition table (S4.3): every (state, op) pair is asserted either legal
 * with a specific target state, or illegal. A partially-specified state machine is how a suspended
 * token quietly becomes authorizable again.
 */
class TokenStateMachineTest {

    @ParameterizedTest(name = "{0} --{1}--> {2}")
    @CsvSource({
            "PENDING_IDV, ACTIVATE, ACTIVE",
            "PENDING_IDV, DELETE,   DELETED",
            "ACTIVE,      SUSPEND,  SUSPENDED",
            "ACTIVE,      DELETE,   DELETED",
            "SUSPENDED,   RESUME,   ACTIVE",
            "SUSPENDED,   DELETE,   DELETED"
    })
    @DisplayName("legal transitions reach the expected state")
    void legalTransitions(TokenStatus from, LifecycleOp op, TokenStatus expected) {
        assertThat(TokenStateMachine.allows(from, op)).isTrue();
        assertThat(TokenStateMachine.next(from, op)).isEqualTo(expected);
    }

    @ParameterizedTest(name = "{0} --{1}--> rejected")
    @CsvSource({
            "PENDING_IDV, SUSPEND",
            "PENDING_IDV, RESUME",
            "ACTIVE,      ACTIVATE",
            "ACTIVE,      RESUME",
            "SUSPENDED,   ACTIVATE",
            "SUSPENDED,   SUSPEND",
            "DELETED,     ACTIVATE",
            "DELETED,     SUSPEND",
            "DELETED,     RESUME",
            "DELETED,     DELETE"
    })
    @DisplayName("illegal transitions throw, which the API surfaces as 409")
    void illegalTransitions(TokenStatus from, LifecycleOp op) {
        assertThat(TokenStateMachine.allows(from, op)).isFalse();
        assertThatThrownBy(() -> TokenStateMachine.next(from, op))
                .isInstanceOf(IllegalTransitionException.class)
                .hasMessageContaining(from.name())
                .hasMessageContaining(op.name());
    }

    @Test
    @DisplayName("the table is total: every state/op pair is decided one way or the other")
    void tableIsTotal() {
        int decided = 0;
        for (TokenStatus from : TokenStatus.values()) {
            for (LifecycleOp op : LifecycleOp.values()) {
                boolean allowed = TokenStateMachine.allows(from, op);
                if (allowed) {
                    assertThat(TokenStateMachine.next(from, op)).isNotNull();
                } else {
                    assertThatThrownBy(() -> TokenStateMachine.next(from, op))
                            .isInstanceOf(IllegalTransitionException.class);
                }
                decided++;
            }
        }
        assertThat(decided).isEqualTo(TokenStatus.values().length * LifecycleOp.values().length);
    }

    @Test
    @DisplayName("DELETED is terminal, including for a repeated DELETE")
    void deletedIsTerminal() {
        assertThat(TokenStateMachine.legalOps(TokenStatus.DELETED)).isEmpty();
    }

    @Test
    @DisplayName("only ACTIVE may authorize")
    void onlyActiveAuthorizes() {
        assertThat(TokenStatus.ACTIVE.canAuthorize()).isTrue();
        assertThat(TokenStatus.PENDING_IDV.canAuthorize()).isFalse();
        assertThat(TokenStatus.SUSPENDED.canAuthorize()).isFalse();
        assertThat(TokenStatus.DELETED.canAuthorize()).isFalse();
    }
}
