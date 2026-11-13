import { Migration } from '@mikro-orm/migrations'

export class Migration20261112100000_ShareTarget extends Migration {
	override up() {
		this.addSql('alter table `source` add column `is_share_target` integer null;')
	}

	override down() {
		this.addSql('alter table `source` drop column `is_share_target`;')
	}
}
