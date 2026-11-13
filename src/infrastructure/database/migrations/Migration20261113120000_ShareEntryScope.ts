import { Migration } from '@mikro-orm/migrations'

export class Migration20261113120000_ShareEntryScope extends Migration {
	override up() {
		this.addSql('alter table `share_capability` add column `entry_id` text null;')
	}

	override down() {
		this.addSql('alter table `share_capability` drop column `entry_id`;')
	}
}
