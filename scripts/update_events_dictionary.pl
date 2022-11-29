#!//usr/bin/perl

# apt-get install libjson-perl libxml-simple-perl libxml-writer-perl

use strict;
use utf8;

use JSON;
use XML::Simple;
use XML::Writer;

my $client_id = '584216729178-3l07e654m1uarh2ai6v6u5reaqsbscdc.apps.googleusercontent.com';
my $secret = 'x';
my $token = 'x';
my $spreadsheet_key = 'x';

my $token_post_data = "refresh_token=$token\&client_id=$client_id\&client_secret=$secret\&grant_type=refresh_token";
my $result = `curl -s --header "Content-Type: application/x-www-form-urlencoded" --data '$token_post_data' https://accounts.google.com/o/oauth2/token`;

my $result_data = decode_json( $result );

my $access_token = $result_data->{access_token};
my $token_type = $result_data->{token_type};

my $ws_xml = `curl -s -H 'Authorization: $token_type $access_token' 'https://spreadsheets.google.com/feeds/worksheets/$spreadsheet_key/private/full'`;

my $ws_data = XML::Simple->new( ForceArray => 1 )->XMLin( $ws_xml );
my $links = $ws_data->{entry}->[0]->{link};

my ( $listfeed_link ) = grep { $_->{rel} eq 'http://schemas.google.com/spreadsheets/2006#listfeed' } @$links;
$listfeed_link = $listfeed_link->{href};

my $listfeed_xml = `curl -s -H 'Authorization: $token_type $access_token' '$listfeed_link'`;

my $listfeed_data = XML::Simple->new( ForceArray => 1 )->XMLin( $listfeed_xml );

my ( $post_link ) = grep { $_->{rel} eq 'http://schemas.google.com/g/2005#post' } @{ $listfeed_data->{link} };
$post_link = $post_link->{href};

my $rows = _google_listfeed_to_array_of_hashes( $listfeed_data );
my $rows_by_key = { map { $_->{'gsx:eventid'} => $_ } @$rows };

my @missing = ();
my $csvfile = `cat /usr/local/meetings/meetings/events_dictionary.csv`;
for my $row ( split /\n/, $csvfile ) {
    my ( $key ) = $row =~ /\,"([^"]+)"/;
    next if $rows_by_key->{ $key };
    push @missing, {
        'gsx:eventid' => $key,
    };
}

for my $params ( @missing ) {
    my $payload = _generate_google_listfeed_entry( $params );
    $payload =~ s/'/'"'"'/g;
    `curl -s -X POST -d '$payload' -H 'Content-Type: application/atom+xml' -H 'Authorization: $token_type $access_token' '$post_link'`;
}

`curl -s 'https://docs.google.com/spreadsheet/pub?key=x&single=true&gid=0&output=csv' | tail -n +2 > /usr/local/meetings/meetings/events_dictionary.csv`;


sub _google_listfeed_to_array_of_hashes {
    my ( $listfeed_data ) = @_;

    my $entries = $listfeed_data->{entry} || [];
    my $array = [];

    for my $e ( @$entries ) {
        my $hash = {};
        my $save = 0;
        for my $key ( keys %$e ) {
            my ( $realkey ) = $key =~ /^(gsx\:.*)/;
            next unless $realkey;
            next if ref ( $e->{ $key }->[0] );
            $hash->{ $realkey } = ( $e->{ $key }->[0] );
            $save = 1;
        }

        if ( $save ) {
            my ( $link ) = grep { $_->{rel} eq 'edit' } @{ $e->{link} };

            $hash->{edit_link} = $link->{href};
            $hash->{id} = $e->{id}->[0];

            push @$array, $hash;
        }
    }

    return $array;
}

sub _generate_google_listfeed_entry {
    my ( $params ) = @_;

    my $output = '';
    my $writer = XML::Writer->new( OUTPUT => \$output );

    $writer->startTag("entry", xmlns => "http://www.w3.org/2005/Atom", "xmlns:gsx" => "http://schemas.google.com/spreadsheets/2006/extended");

    if ( $params->{id} ) {
        $writer->dataElement( id => $params->{id} );
    }

    for my $key ( keys ( %$params ) ) {
        next unless $key =~ /^gsx\:/;
        $writer->dataElement( $key => $params->{ $key } );
    }

    $writer->endTag("entry");
    $writer->end();

    return $output;
}

