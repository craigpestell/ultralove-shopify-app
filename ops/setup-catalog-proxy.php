<?php
if ( ! defined( 'WP_CLI' ) || ! WP_CLI || wp_get_environment_type() !== 'development'
    || home_url() !== 'https://dev.ultralove.ca' || DB_NAME !== 'wordpress_dev' ) {
    throw new RuntimeException( 'Catalog proxy credential setup is dev-only.' );
}
$path = '/var/lib/ultralove-catalog-proxy/feed-client.json';
if ( file_exists( $path ) ) {
    WP_CLI::success( 'Separate catalog proxy credential is already provisioned.' );
    return;
}
$worker = json_decode( file_get_contents( '/root/.ultralove-shopify-dev/feed-client.json' ), true, 512, JSON_THROW_ON_ERROR );
$user = get_user_by( 'login', $worker['username'] );
if ( ! $user || ! user_can( $user, 'ultralove_read_product_feed' ) || user_can( $user, 'manage_woocommerce' )
    || user_can( $user, 'manage_options' ) ) {
    throw new RuntimeException( 'A dedicated catalog-only account is required.' );
}
$created = WP_Application_Passwords::create_new_application_password( $user->ID, array(
    'name' => 'UltraLove embedded catalog read-only proxy',
) );
if ( is_wp_error( $created ) ) {
    throw new RuntimeException( 'Could not issue the separate catalog credential.' );
}
$json = json_encode( array( 'username' => $user->user_login, 'password' => $created[0],
    'uuid' => $created[1]['uuid'] ), JSON_THROW_ON_ERROR );
if ( file_put_contents( $path, $json, LOCK_EX ) !== strlen( $json ) ) {
    WP_Application_Passwords::delete_application_password( $user->ID, $created[1]['uuid'] );
    throw new RuntimeException( 'Could not persist the catalog credential; it was revoked.' );
}
if ( ! chgrp( $path, 'ultralove-catalog-proxy' ) || ! chmod( $path, 0640 ) ) {
    WP_Application_Passwords::delete_application_password( $user->ID, $created[1]['uuid'] );
    unlink( $path );
    throw new RuntimeException( 'Could not protect the catalog credential; it was revoked.' );
}
WP_CLI::success( 'Separate catalog-only proxy credential provisioned without displaying it.' );
