package com.adxztech.pts.provisioning;

import com.adxztech.pts.common.api.CardUpdateRequest;
import com.adxztech.pts.common.api.CardUpdateResponse;
import jakarta.validation.Valid;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Card reissue / expiry refresh (S5.5). */
@RestController
@RequestMapping(path = "/v1/cards", produces = MediaType.APPLICATION_JSON_VALUE)
public class CardController {

    private final CardUpdateService cardUpdateService;

    public CardController(CardUpdateService cardUpdateService) {
        this.cardUpdateService = cardUpdateService;
    }

    @PostMapping(path = "/update", consumes = MediaType.APPLICATION_JSON_VALUE)
    public CardUpdateResponse update(@Valid @RequestBody CardUpdateRequest request) {
        return cardUpdateService.update(request);
    }
}
