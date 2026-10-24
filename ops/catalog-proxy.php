<?php
if ( PHP_SAPI !== 'cli' || defined( 'ABSPATH' ) || getenv( 'SSH_ORIGINAL_COMMAND' ) !== 'catalog-read' ) {
    exit( 1 );
}
try {
    // Fifty bounded ID/checkpoint pairs can exceed the old single-request limit.
    $input = stream_get_contents( STDIN, 8193 );
    if ( strlen( $input ) > 8192 ) {
        throw new RuntimeException( 'Catalog request exceeds its limit.' );
    }
    $request = json_decode( $input, true, 512, JSON_THROW_ON_ERROR );
    if ( ! is_array( $request ) || array_diff( array_keys( $request ), array( 'operation', 'filters', 'ids', 'location', 'run', 'markup', 'checkpoint', 'checkpoints' ) )
        || ( array_key_exists( 'checkpoints', $request ) && ( $request['operation'] ?? '' ) !== 'inventory-sync-batch' ) ) {
        throw new RuntimeException( 'Invalid catalog operation.' );
    }
    require '/var/www/html/wp-content/plugins/ultralove-shopify-supplier/includes/class-feed-client.php';
    $credentials = json_decode( file_get_contents( '/var/lib/ultralove-catalog-proxy/feed-client.json' ), true, 512, JSON_THROW_ON_ERROR );
    $transport = static function ( string $url, array $arguments ): array {
        if ( ! preg_match( '~^http://localhost/wp-json/ultralove-feed/v1/(products|categories|inventory|changes|shopify-stores)(\?|$)~', $url ) ) {
            throw new RuntimeException( 'Unsupported supplier endpoint.' );
        }
        $headers = array();
        foreach ( $arguments['headers'] as $name => $value ) {
            $headers[] = $name . ': ' . $value;
        }
        $response_headers = array();
        $curl = curl_init( $url );
        curl_setopt_array( $curl, array( CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_CONNECTTIMEOUT => 10, CURLOPT_TIMEOUT => 120, CURLOPT_HTTPHEADER => $headers,
            CURLOPT_HEADERFUNCTION => static function ( $handle, string $line ) use ( &$response_headers ): int {
                if ( str_contains( $line, ':' ) ) {
                    list( $name, $value ) = explode( ':', $line, 2 );
                    $response_headers[strtolower( trim( $name ) )] = trim( $value );
                }
                return strlen( $line );
            },
        ) );
        $body = curl_exec( $curl );
        $status = curl_getinfo( $curl, CURLINFO_RESPONSE_CODE );
        if ( $body === false ) {
            throw new RuntimeException( 'Supplier transport failed: curl ' . curl_errno( $curl ) . '.' );
        }
        return array( 'status' => $status, 'headers' => $response_headers, 'body' => $body );
    };
    $client = new UltraLove_Shopify_Feed_Client( $credentials, $transport );
    $filters = $request['filters'] ?? array();
    if ( ! is_array( $filters ) || isset( $filters['per_page'] ) || isset( $filters['parents_only'] ) ) {
        throw new RuntimeException( 'Catalog page bounds cannot be overridden.' );
    }
    switch ( $request['operation'] ?? '' ) {
        case 'products':
            $result = $client->products_page( $filters );
            break;
        case 'categories':
            $result = $client->categories_page( $filters );
            break;
        case 'selection':
            $result = $client->selected_products( $request['ids'] ?? array() );
            $parents = array_values( array_filter( $result['products'],
                static fn( $product ) => $product['parent_id'] === 0 ) );
            $result = array(
                'ids' => array_column( $parents, 'id' ),
                'products' => array_map( static fn( $product ) => array(
                    'id' => $product['id'],
                    // The SKU has its own column; show the cleaned name when the feed has one (feed 1.3+).
                    'name' => is_string( $product['clean_name'] ?? null ) && trim( $product['clean_name'] ) !== '' ? $product['clean_name'] : $product['name'],
                    'sku' => $product['sku'],
                    'price' => $product['price'], 'type' => $product['type'],
                    // Feed 1.3: testers, displays and other store-only products; older feeds omit it.
                    'wholesale_only' => ( $product['wholesale_only'] ?? false ) === true,
                ), $parents ),
            );
            break;
        case 'shopify-stores':
            // Feed 1.6: stores UltraLove approved for the Shopify app.
            if ( ! method_exists( $client, 'shopify_stores' ) ) {
                throw new RuntimeException( 'The approved Shopify store list is not provisioned.' );
            }
            $result = $client->shopify_stores();
            break;
        case 'inventory-sync':
            if ( ! method_exists( $client, 'inventory_state' ) ) {
                throw new RuntimeException( 'Supplier inventory synchronization is not provisioned.' );
            }
            if ( ! is_array( $request['ids'] ?? null ) || count( $request['ids'] ) !== 1
                || ! is_int( $request['ids'][0] ?? null )
                || ( isset( $request['checkpoint'] ) && ! is_array( $request['checkpoint'] ) ) ) {
                throw new InvalidArgumentException( 'Invalid inventory synchronization request.' );
            }
            $result = $client->inventory_state( $request['ids'][0], $request['checkpoint'] ?? null );
            break;
        case 'inventory-sync-batch':
            if ( ! method_exists( $client, 'inventory_states' ) ) {
                throw new RuntimeException( 'Supplier batch inventory synchronization is not provisioned.' );
            }
            if ( array_diff( array_keys( $request ), array( 'operation', 'ids', 'checkpoints' ) )
                || ! is_array( $request['ids'] ?? null ) || ! is_array( $request['checkpoints'] ?? null ) ) {
                throw new InvalidArgumentException( 'Invalid batch inventory synchronization request.' );
            }
            $result = $client->inventory_states( $request['ids'], $request['checkpoints'] );
            break;
        case 'import-plan':
            if ( ! is_string( $request['location'] ?? null ) || ! is_string( $request['run'] ?? null )
                || ! is_numeric( $request['markup'] ?? null ) ) {
                throw new InvalidArgumentException( 'Invalid import planning parameters.' );
            }
            require '/var/www/html/wp-content/plugins/ultralove-shopify-supplier/includes/class-catalog-import.php';
            $feed = $client->selected_products( $request['ids'] ?? array() );
            $items = array();
            foreach ( $request['ids'] as $id ) {
                $record = $feed['products'][$id];
                if ( ( $record['wholesale_only'] ?? false ) === true ) {
                    throw new RuntimeException( 'Wholesale-only product selected; no import planned.' );
                }
                $payload = UltraLove_Shopify_Catalog_Import::payload( $record, $feed['products'],
                    $request['location'], $request['run'], (float) $request['markup'] );
                $wholesale = array();
                foreach ( $payload['variants'] as $variant ) {
                    $source_id = (int) $variant['metafields'][0]['value'];
                    $wholesale[] = $feed['products'][$source_id]['price'];
                }
                $items[] = array( 'supplierId' => $id, 'name' => $record['name'], 'sku' => $record['sku'],
                    'wholesale' => $wholesale, 'payload' => $payload );
            }
            $result = array( 'generation' => $feed['generation'], 'cursor' => $feed['cursor'], 'items' => $items );
            break;
        default:
            throw new RuntimeException( 'Unsupported catalog operation.' );
    }
    echo json_encode( $result, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES ) . "\n";
} catch ( RuntimeException | InvalidArgumentException | JsonException $error ) {
    // The supplier import also refuses a product whose every variant is wholesale-only (feed 1.4).
    if ( in_array( $error->getMessage(), array( 'Wholesale-only product selected; no import planned.',
        'Wholesale-only products (testers, displays) are not offered for dropshipping.' ), true ) ) {
        echo json_encode( array( 'error' => array( 'status' => 409, 'code' => 'WHOLESALE_ONLY' ) ), JSON_THROW_ON_ERROR ) . "\n";
    } elseif ( $error->getMessage() === 'Selected product/variation is missing or unavailable; no partial import.' ) {
        echo json_encode( array( 'error' => array( 'status' => 409, 'code' => 'SELECTED_PRODUCT_UNAVAILABLE' ) ), JSON_THROW_ON_ERROR ) . "\n";
    } elseif ( $error->getCode() === 429 && preg_match( '/; retry after ([0-9]+) seconds/', $error->getMessage(), $matches )
        && (int) $matches[1] > 0 && (int) $matches[1] <= 2147483647 ) {
        echo json_encode( array( 'error' => array( 'status' => 429, 'retryAfter' => (int) $matches[1] ) ), JSON_THROW_ON_ERROR ) . "\n";
    }
    fwrite( STDERR, 'Catalog proxy failed: ' . $error->getMessage() . "\n" );
    exit( 1 );
}
