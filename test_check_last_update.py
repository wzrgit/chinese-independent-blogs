import unittest
from unittest.mock import patch

import check_last_update


class CheckEntryTest(unittest.TestCase):
    def entry(self, feed_url='https://example.com/feed.xml'):
        return {
            'feed_url': feed_url,
            'address': 'https://example.com/',
        }

    @patch('check_last_update.is_url_accessible')
    @patch('check_last_update.parse_feed', return_value=('2026-09-14', 'Post'))
    @patch('check_last_update.fetch_feed', return_value=(b'<feed/>', None))
    def test_accessible_feed_skips_website_check(self, fetch_feed, parse_feed, is_url_accessible):
        entry = self.entry()

        result = check_last_update.check_entry(entry)

        self.assertEqual((entry, '2026/09/14 00:00:00', 'Post'), result)
        is_url_accessible.assert_not_called()

    @patch('check_last_update.is_url_accessible', return_value=True)
    @patch('check_last_update.fetch_feed', return_value=(None, 'timeout'))
    def test_inaccessible_feed_falls_back_to_accessible_website(self, fetch_feed, is_url_accessible):
        entry = self.entry()

        result = check_last_update.check_entry(entry)

        self.assertEqual((entry, 'x', 'x'), result)
        is_url_accessible.assert_called_once_with(entry['address'])

    @patch('check_last_update.is_url_accessible', return_value=False)
    @patch('check_last_update.fetch_feed', return_value=(None, 'timeout'))
    def test_inaccessible_feed_and_website_uses_distinct_symbol(self, fetch_feed, is_url_accessible):
        entry = self.entry()

        result = check_last_update.check_entry(entry)

        self.assertEqual((entry, '!', '!'), result)

    @patch('check_last_update.is_url_accessible', return_value=False)
    def test_missing_feed_and_inaccessible_website_uses_distinct_symbol(self, is_url_accessible):
        entry = self.entry(feed_url=None)

        result = check_last_update.check_entry(entry)

        self.assertEqual((entry, '!', '!'), result)

    @patch('check_last_update.is_url_accessible')
    @patch('check_last_update.parse_feed', return_value=(None, None))
    @patch('check_last_update.fetch_feed', return_value=(b'not a feed', None))
    def test_feed_response_with_parse_error_skips_website_check(
        self, fetch_feed, parse_feed, is_url_accessible
    ):
        entry = self.entry()

        result = check_last_update.check_entry(entry)

        self.assertEqual((entry, 'x', 'x'), result)
        is_url_accessible.assert_not_called()


if __name__ == '__main__':
    unittest.main()
