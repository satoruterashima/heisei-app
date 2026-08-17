import React, { useState } from 'react';
import { StyleSheet, Text, View, SafeAreaView, ScrollView, TouchableOpacity } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { HEISEI_COLORS } from '@heisei/domain';
import { Home, MessageSquare, Users, User, Menu } from 'lucide-react-native';

export default function App() {
  const [activeTab, setActiveTab] = useState<'home' | 'threads' | 'community' | 'friends' | 'menu'>('home');

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="dark" />
      
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>HEISEI</Text>
        <Text style={styles.headerSubtitle}>平成の好きが見つかる交流SNS (iOS App)</Text>
      </View>

      {/* Main Content Area */}
      <ScrollView style={styles.content} contentContainerStyle={styles.contentContainer}>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>📱 React Native + Expo 移行完了</Text>
          <Text style={styles.cardText}>
            HEISEIアプリのモバイル（iOS）開発基盤が正常に初期化されました。
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>✨ 「本日のトレンディ」</Text>
          <Text style={styles.cardText}>
            1998年：たまごっち・宇多田ヒカルデビュー等の話題
          </Text>
        </View>
      </ScrollView>

      {/* 5-Item Bottom Navigation (iOS 固定仕様) */}
      <View style={styles.bottomNav}>
        <TouchableOpacity
          style={styles.navItem}
          onPress={() => setActiveTab('home')}
        >
          <Home size={22} color={activeTab === 'home' ? HEISEI_COLORS.accent : HEISEI_COLORS.secondary} />
          <Text style={[styles.navLabel, activeTab === 'home' && styles.activeNavLabel]}>ホーム</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.navItem}
          onPress={() => setActiveTab('threads')}
        >
          <MessageSquare size={22} color={activeTab === 'threads' ? HEISEI_COLORS.accent : HEISEI_COLORS.secondary} />
          <Text style={[styles.navLabel, activeTab === 'threads' && styles.activeNavLabel]}>スレッド</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.navItem}
          onPress={() => setActiveTab('community')}
        >
          <Users size={22} color={activeTab === 'community' ? HEISEI_COLORS.accent : HEISEI_COLORS.secondary} />
          <Text style={[styles.navLabel, activeTab === 'community' && styles.activeNavLabel]}>コミュニティ</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.navItem}
          onPress={() => setActiveTab('friends')}
        >
          <User size={22} color={activeTab === 'friends' ? HEISEI_COLORS.accent : HEISEI_COLORS.secondary} />
          <Text style={[styles.navLabel, activeTab === 'friends' && styles.activeNavLabel]}>マイフレ</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.navItem}
          onPress={() => setActiveTab('menu')}
        >
          <Menu size={22} color={activeTab === 'menu' ? HEISEI_COLORS.accent : HEISEI_COLORS.secondary} />
          <Text style={[styles.navLabel, activeTab === 'menu' && styles.activeNavLabel]}>メニュー</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F2F4F7',
  },
  header: {
    paddingHorizontal: 20,
    paddingVertical: 14,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#0C4B63',
  },
  headerSubtitle: {
    fontSize: 12,
    color: '#6B7280',
    marginTop: 2,
  },
  content: {
    flex: 1,
  },
  contentContainer: {
    padding: 16,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#1A2E4A',
    marginBottom: 6,
  },
  cardText: {
    fontSize: 14,
    color: '#4B5563',
    lineHeight: 20,
  },
  bottomNav: {
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
    paddingVertical: 8,
    paddingBottom: 24, // Safe Area padding for iOS
  },
  navItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  navLabel: {
    fontSize: 10,
    color: '#1A2E4A',
    marginTop: 4,
  },
  activeNavLabel: {
    color: '#FF2D6F',
    fontWeight: 'bold',
  },
});
