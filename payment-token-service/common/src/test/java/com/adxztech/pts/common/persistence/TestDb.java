package com.adxztech.pts.common.persistence;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabase;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseBuilder;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseType;

/**
 * Spins up an isolated H2 database from the shipped schema.
 *
 * <p>Deliberately the <em>same</em> {@code db/h2/schema.sql} the services boot with -- a test schema
 * maintained separately would drift, and these tests exist to catch exactly that drift.
 */
final class TestDb {

    private TestDb() {
    }

    static EmbeddedDatabase create() {
        return new EmbeddedDatabaseBuilder()
                .setType(EmbeddedDatabaseType.H2)
                .generateUniqueName(true)
                .addScript("classpath:db/h2/schema.sql")
                .build();
    }

    static JdbcTemplate template(EmbeddedDatabase db) {
        return new JdbcTemplate(db);
    }
}
