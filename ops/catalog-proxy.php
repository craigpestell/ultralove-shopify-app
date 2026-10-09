<?php
if ( PHP_SAPI !== 'cli' || defined( 'ABSPATH' ) || getenv( 'SSH_ORIGINAL_COMMAND' ) !== 'catalog-read' ) {
    exit( 1 );
}
try {
    $input = stream_get_contents( STDIN, 4097 );
    if ( strlen( $input ) > 4096 ) {
        throw new RuntimeException( 'Catalog request exceeds its limit.' );
    }
    $request = json_decode( $input, true, 512, JSON_THROW_ON_ERROR );
    if ( ! is_array( $request ) || array_diff( array_keys( $request ), array( 'operation', 'filters', 'ids' ) ) ) {
        throw new RuntimeException( 'Invalid catalog operation.' );
    }
    require '/var/www/html/wp-content/plugins/ultralove-shopify-supplier/includes/class-feed-client.php';
    $credentials = json_decode( file_get_contents( '/var/lib/ultralove-catalog-proxy/feed-client.json' ), true, 512, JSON_THROW_ON_ERROR );
    $transport = static function ( string $url, array $arguments ): array {
        if ( ! preg_match( '~^http://localhost/wp-json/ultralove-feed/v1/(products|categories)\?~', $url ) ) {
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
            $result = array( 'ids' => array_values( array_filter( array_keys( $result['products'] ),
                static fn( $id ) => $result['products'][$id]['parent_id'] === 0 ) ) );
            break;
        default:
            throw new RuntimeException( 'Unsupported catalog operation.' );
    }
    echo json_encode( $result, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES ) . "\n";
} catch ( RuntimeException | InvalidArgumentException | JsonException $error ) {
    fwrite( STDERR, 'Catalog proxy failed: ' . $error->getMessage() . "\n" );
    exit( 1 );
}
