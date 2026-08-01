package com.adxztech.pts.provisioning;

import com.adxztech.pts.common.client.IssuerSimClient;
import com.adxztech.pts.common.client.RestClients;
import com.adxztech.pts.common.event.EventBroker;
import com.adxztech.pts.common.event.HttpEventBroker;
import com.adxztech.pts.common.event.InMemoryEventBroker;
import com.adxztech.pts.common.trace.TraceHeaderInterceptor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.kafka.core.KafkaTemplate;

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(ProvisioningProperties.class)
public class ProvisioningBeansConfig {

    private static final Logger log = LoggerFactory.getLogger(ProvisioningBeansConfig.class);

    @Bean
    public IssuerSimClient issuerSimClient(ProvisioningProperties properties,
                                           TraceHeaderInterceptor traceInterceptor) {
        return new IssuerSimClient(
                RestClients.controlPlane(properties.getIssuerSimUrl(), traceInterceptor));
    }

    /**
     * Selects the event transport (S10.2).
     *
     * <p>Whichever is chosen, the guarantee is the same, because it does not come from the broker: the
     * outbox makes the event durable with the state change, and the consumer's {@code eventId} dedupe
     * makes delivery exactly-once in effect.
     */
    @Bean
    public EventBroker eventBroker(ProvisioningProperties properties,
                                   TraceHeaderInterceptor traceInterceptor,
                                   ObjectProvider<KafkaTemplate<String, Object>> kafkaTemplate) {
        ProvisioningProperties.Events events = properties.getEvents();
        EventBroker broker = switch (events.getTransport()) {
            case IN_MEMORY -> {
                InMemoryEventBroker inMemory = new InMemoryEventBroker();
                inMemory.setDeliveriesPerEvent(events.getDeliveriesPerEvent());
                yield inMemory;
            }
            case HTTP -> new HttpEventBroker(
                    RestClients.controlPlane(events.getNotificationUrl(), traceInterceptor),
                    "/events", events.getDeliveriesPerEvent());
            case KAFKA -> {
                KafkaTemplate<String, Object> template = kafkaTemplate.getIfAvailable();
                if (template == null) {
                    throw new IllegalStateException(
                            "provisioning.events.transport=KAFKA but no KafkaTemplate is available");
                }
                yield new KafkaEventBroker(template, events.getKafkaTopic());
            }
        };
        log.info("lifecycle event transport: {}", broker.describe());
        return broker;
    }
}
